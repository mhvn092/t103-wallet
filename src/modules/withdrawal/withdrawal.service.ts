import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { PAUSED_WITHDRAWALS_CONTROL_KEY } from '../../common/constants/system-controls.constants.js';
import {
  Currency,
  DiscrepancyRefType,
  DiscrepancyStatus,
  DiscrepancyType,
  PayoutStatusValue,
  UserAccountType,
  WithdrawalFailureReason,
  WithdrawalStatus,
} from '../../common/enums/domain.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  addJitterMs,
  addPositiveJitterMs,
  computeJitteredBackoffMs,
  computeSafeLeaseMs,
} from '../../common/utils/backoff.util.js';
import { assertValidDestination } from '../../common/utils/destination-validator.util.js';
import {
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import { getTehranDateString } from '../../common/utils/tehran-date.util.js';
import { assertValidUuid } from '../../common/utils/uuid-validation.util.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DbTransaction } from '../../database/database.types.js';
import {
  financialDiscrepancies,
  systemControls,
  withdrawals,
} from '../../database/schema/index.js';
import { userIdempotencyScope } from '../idempotency/idempotency.util.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { IdempotentExecutionResult } from '../idempotency/idempotency.types.js';
import { verifyHmacSha256Hex } from '../providers/hmac.util.js';
import { PayoutClient } from '../providers/payout.client.js';
import type { PayoutTransferStatusResult } from '../providers/provider.types.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { WithdrawalCreateDto } from './dto/withdrawal-create.dto.js';
import type { WithdrawalResolveDto } from './dto/withdrawal-resolve.dto.js';
import type {
  WithdrawalResponseDto,
  WithdrawalWebhookAckDto,
} from './dto/withdrawal-response.dto.js';
import { WithdrawalLedgerService } from './withdrawal-ledger.service.js';
import {
  decideWithdrawalTransition,
  toWithdrawalStatus,
} from './withdrawal-state-machine.util.js';
import { detectProviderPayloadMismatch } from './withdrawal-webhook.util.js';
import {
  WITHDRAWAL_DISPATCH_LEASE_MS,
  WITHDRAWAL_PROCESSING_POLL_DELAY_MS,
  WITHDRAWAL_PROCESSING_POLL_LEASE_MS,
} from './withdrawal.constants.js';
import {
  computeWithdrawalPolicyAmounts,
  toWithdrawalResponseDto,
} from './withdrawal.mapper.js';
import { payoutWebhookPayloadSchema } from './withdrawal.schemas.js';
import type {
  ClaimedWithdrawalDispatchItem,
  WithdrawalEntity,
} from './withdrawal.types.js';

@Injectable()
export class WithdrawalService {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _databaseService: DatabaseService,
    private readonly _idempotencyService: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _withdrawalLedgerService: WithdrawalLedgerService,
    private readonly _payoutClient: PayoutClient,
  ) {}

  async createWithdrawal(params: {
    idempotencyKey: string;
    requestHash?: string;
    dto: WithdrawalCreateDto;
  }): Promise<IdempotentExecutionResult<WithdrawalResponseDto>> {
    const { dto } = params;
    const limitDate = getTehranDateString();
    const availableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: UserAccountType.AVAILABLE,
    };
    const lockedSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: UserAccountType.LOCKED,
    };
    const receivableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: UserAccountType.RECEIVABLE,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec, lockedSpec, receivableSpec],
      dailyLimitKeys: [{ userId: dto.userId, limitDate }],
      restrictionUserIds: [dto.userId],
    });

    return this._idempotencyService.executeInTransaction<WithdrawalResponseDto>(
      {
        scope: userIdempotencyScope('POST:/withdrawals', dto.userId),
        key: params.idempotencyKey,
        requestBody: dto,
        requestHashOverride: params.requestHash,
        handler: async (tx) => {
          const amountMinor = parseAmountToMinor(dto.amount, dto.currency);
          const normalizedDest = assertValidDestination(
            dto.destination,
            dto.currency,
          );
          this._assertAboveMinimum(amountMinor, dto.currency);
          const policy = computeWithdrawalPolicyAmounts(
            this._configService,
            amountMinor,
            dto.currency,
          );

          await this._assertCurrencyNotPaused(tx, dto.currency);
          const usedIrt = await this._walletService.lockDailyLimit(
            tx,
            dto.userId,
            limitDate,
          );
          const frozen = await this._walletService.lockUserRestriction(
            tx,
            dto.userId,
          );
          if (frozen) {
            throw new DomainException(
              HttpStatus.FORBIDDEN,
              ErrorCode.OUTBOUND_FROZEN,
              'Outbound transfers and withdrawals are frozen for this account',
            );
          }

          const lockedAccounts =
            await this._walletService.lockUserAccountsCanonical(tx, [
              availableSpec,
              lockedSpec,
            ]);
          const userAvailable = this._walletService.getRequiredLockedAccount(
            lockedAccounts,
            availableSpec,
          );
          const userLocked = this._walletService.getRequiredLockedAccount(
            lockedAccounts,
            lockedSpec,
          );

          if (usedIrt + policy.irtEquivalent > policy.dailyLimitIrt) {
            throw new DomainException(
              HttpStatus.UNPROCESSABLE_ENTITY,
              ErrorCode.DAILY_LIMIT_EXCEEDED,
              'Withdrawal exceeds remaining daily limit',
            );
          }

          const totalHold = amountMinor + policy.feeMinor;
          const availableBalance = BigInt(userAvailable.balance ?? '0');
          if (availableBalance < totalHold) {
            throw new DomainException(
              HttpStatus.UNPROCESSABLE_ENTITY,
              ErrorCode.INSUFFICIENT_FUNDS,
              'Insufficient available balance for withdrawal and fee',
            );
          }

          const inserted =
            await this._withdrawalLedgerService.createWithdrawalWithHold(tx, {
              userId: dto.userId,
              currency: dto.currency,
              amountMinor,
              normalizedDest,
              limitDate,
              policy,
              userAvailable,
              userLocked,
            });

          return toWithdrawalResponseDto(inserted);
        },
      },
    );
  }

  async getWithdrawal(
    withdrawalId: string,
    userId?: string,
  ): Promise<WithdrawalResponseDto> {
    const validId = assertValidUuid(withdrawalId, 'withdrawalId');
    const row = await this._requireWithdrawal(validId);
    if (userId !== undefined && row.userId !== userId) {
      throw new DomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Withdrawal not found',
      );
    }
    return toWithdrawalResponseDto(row);
  }

  async cancelWithdrawal(params: {
    withdrawalId: string;
    userId: string;
    idempotencyKey: string;
    requestHash?: string;
  }): Promise<IdempotentExecutionResult<WithdrawalResponseDto>> {
    const validId = assertValidUuid(params.withdrawalId, 'withdrawalId');

    return this._idempotencyService.executeInTransaction<WithdrawalResponseDto>(
      {
        scope: userIdempotencyScope(
          'POST:/withdrawals/:id/cancel',
          params.userId,
        ),
        key: params.idempotencyKey,
        requestBody: { id: validId, body: {} },
        requestHashOverride: params.requestHash,
        statusCode: HttpStatus.OK,
        handler: async (tx) => {
          const [locked] = await tx
            .select()
            .from(withdrawals)
            .where(
              and(
                eq(withdrawals.id, validId),
                eq(withdrawals.userId, params.userId),
              ),
            )
            .for('update')
            .limit(1);

          if (!locked) {
            throw new DomainException(
              HttpStatus.NOT_FOUND,
              ErrorCode.NOT_FOUND,
              'Withdrawal not found',
            );
          }

          const action = decideWithdrawalTransition(
            {
              status: toWithdrawalStatus(locked.status),
              failureReason: locked.failureReason,
              terminalReturn: locked.terminalReturn,
              lateSuccessConflict: locked.lateSuccessConflict,
              hasPriorSettlementOrReturn: false,
              authoritativeConfirmed: false,
            },
            { kind: 'USER_CANCEL' },
          );

          if (action.kind === 'NOOP') {
            return toWithdrawalResponseDto(locked);
          }

          if (action.kind === 'INVALID_TRANSITION') {
            throw new DomainException(
              HttpStatus.CONFLICT,
              ErrorCode.INVALID_STATE_TRANSITION,
              action.reason,
            );
          }

          if (action.kind === 'FAIL_AND_RELEASE') {
            const updated =
              await this._withdrawalLedgerService.failAndReleaseLockedWithdrawal(
                tx,
                locked,
                {
                  reason: WithdrawalFailureReason.CANCELLED_BY_USER,
                  markTerminalReturn: action.markTerminalReturn,
                },
              );
            return toWithdrawalResponseDto(updated);
          }

          return toWithdrawalResponseDto(locked);
        },
      },
    );
  }

  async resolveManualReview(params: {
    withdrawalId: string;
    idempotencyKey: string;
    requestHash?: string;
    dto: WithdrawalResolveDto;
    operatorId: string;
  }): Promise<IdempotentExecutionResult<WithdrawalResponseDto>> {
    const validId = assertValidUuid(params.withdrawalId, 'withdrawalId');
    const preRead = await this._requireWithdrawal(validId);
    const ccy = preRead.currency;

    await this._walletService.ensureUserScaffold({
      accountSpecs: [
        {
          userId: preRead.userId,
          currency: ccy,
          accountType: UserAccountType.AVAILABLE,
        },
        {
          userId: preRead.userId,
          currency: ccy,
          accountType: UserAccountType.LOCKED,
        },
      ],
      dailyLimitKeys: [
        { userId: preRead.userId, limitDate: preRead.limitDate },
      ],
      restrictionUserIds: [preRead.userId],
    });

    return this._idempotencyService.executeInTransaction<WithdrawalResponseDto>(
      {
        scope: 'POST:/internal/withdrawals/:id/resolve',
        key: params.idempotencyKey,
        requestBody: { id: validId, body: params.dto },
        requestHashOverride: params.requestHash,
        statusCode: HttpStatus.OK,
        handler: async (tx) => {
          const [locked] = await tx
            .select()
            .from(withdrawals)
            .where(eq(withdrawals.id, validId))
            .for('update')
            .limit(1);

          if (!locked) {
            throw new DomainException(
              HttpStatus.NOT_FOUND,
              ErrorCode.NOT_FOUND,
              'Withdrawal not found',
            );
          }

          const action = decideWithdrawalTransition(
            {
              status: toWithdrawalStatus(locked.status),
              failureReason: locked.failureReason,
              terminalReturn: locked.terminalReturn,
              lateSuccessConflict: locked.lateSuccessConflict,
              hasPriorSettlementOrReturn: false,
              authoritativeConfirmed: true,
            },
            { kind: 'OPS_RESOLVE', outcome: params.dto.outcome },
          );

          if (action.kind === 'INVALID_TRANSITION') {
            throw new DomainException(
              HttpStatus.CONFLICT,
              ErrorCode.INVALID_STATE_TRANSITION,
              action.reason,
            );
          }

          if (action.kind === 'SETTLE') {
            const settled =
              await this._withdrawalLedgerService.settleLockedWithdrawal(
                tx,
                locked,
                {
                  providerRefId: params.dto.providerRefId ?? null,
                  operatorId: params.operatorId,
                  reason: params.dto.reason,
                },
              );
            await this._resolveWithdrawalDiscrepancies(tx, locked.id);
            return toWithdrawalResponseDto(settled);
          }

          if (action.kind === 'FAIL_AND_RELEASE') {
            const failed =
              await this._withdrawalLedgerService.failAndReleaseLockedWithdrawal(
                tx,
                locked,
                {
                  reason: params.dto.reason,
                  markTerminalReturn: action.markTerminalReturn,
                  operatorId: params.operatorId,
                },
              );
            await this._resolveWithdrawalDiscrepancies(tx, locked.id);
            return toWithdrawalResponseDto(failed);
          }

          return toWithdrawalResponseDto(locked);
        },
      },
    );
  }

  async dispatchPendingBatch(limit = 10): Promise<number> {
    const claimed = await this._claimDispatchBatch(limit);
    const slaMs = this._configService.get('WD_MANUAL_REVIEW_SLA_MS', {
      infer: true,
    });

    for (const item of claimed) {
      try {
        await this._dispatchSingleItem(item, slaMs);
      } catch (err) {
        this._logger.warn(
          `Dispatch failed for withdrawal=${item.row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return claimed.length;
  }

  async handlePayoutWebhook(params: {
    rawBody: Buffer | undefined;
    signatureHeader: string | undefined;
  }): Promise<WithdrawalWebhookAckDto> {
    const secret = this._configService.get('WEBHOOK_SECRET', { infer: true });
    if (
      !Buffer.isBuffer(params.rawBody) ||
      !verifyHmacSha256Hex(params.rawBody, params.signatureHeader, secret)
    ) {
      throw new DomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_SIGNATURE,
        'Invalid or missing webhook signature',
      );
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(params.rawBody.toString('utf8'));
    } catch {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'Malformed webhook JSON payload',
      );
    }

    const parsed = payoutWebhookPayloadSchema.safeParse(rawJson);
    if (!parsed.success || !parsed.data.requestId || !parsed.data.status) {
      return { received: true };
    }

    const [row] = await this._databaseService.db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.providerRequestId, parsed.data.requestId))
      .limit(1);

    if (!row) {
      return { received: true };
    }

    if (detectProviderPayloadMismatch(row, parsed.data)) {
      const escalated = await this._recordPayloadMismatchAndEscalate({
        row,
        providedAmount: parsed.data.amount ?? null,
        providedCurrency: parsed.data.currency ?? null,
        status: parsed.data.status ?? null,
      });
      return {
        received: true,
        withdrawalId: escalated.id,
        status: escalated.status,
      };
    }

    const updated = await this._applyProviderStatus(
      row.id,
      parsed.data.status,
      {
        providerRefId: parsed.data.refId ?? parsed.data.trackingId ?? null,
        reason: parsed.data.reason ?? parsed.data.failureReason ?? null,
        source: 'WEBHOOK',
      },
    );

    return {
      received: true,
      withdrawalId: updated.withdrawalId,
      status: updated.status,
    };
  }

  async pollProcessingBatch(limit = 10): Promise<number> {
    const now = new Date();
    const slaMs = this._configService.get('WD_MANUAL_REVIEW_SLA_MS', {
      infer: true,
    });

    const claimedRows = await this._databaseService.runInTransaction(
      async (tx) => {
        const due = await tx
          .select()
          .from(withdrawals)
          .where(
            and(
              sql`${withdrawals.status} IN ('PROCESSING', 'MANUAL_REVIEW', 'FAILED')`,
              lte(withdrawals.nextPollAt, now),
            ),
          )
          .orderBy(asc(withdrawals.nextPollAt))
          .limit(limit)
          .for('update', { skipLocked: true });

        if (due.length === 0) {
          return [];
        }

        const ids = due.map((d) => d.id);
        const pollLeaseMs = this._getProcessingPollLeaseMs();
        return tx
          .update(withdrawals)
          .set({
            nextPollAt: new Date(
              now.getTime() + addPositiveJitterMs(pollLeaseMs),
            ),
            version: sql`${withdrawals.version} + 1`,
            updatedAt: now,
          })
          .where(inArray(withdrawals.id, ids))
          .returning();
      },
    );

    for (const row of claimedRows) {
      await this._pollSingleProcessingRow(row, slaMs);
    }

    return claimedRows.length;
  }

  private _assertAboveMinimum(amountMinor: bigint, currency: Currency): void {
    const minStr =
      currency === Currency.IRT
        ? this._configService.get('MIN_WITHDRAWAL_IRT', { infer: true })
        : this._configService.get('MIN_WITHDRAWAL_USDT', { infer: true });
    const minMinor = parseAmountToMinor(minStr, currency);
    if (amountMinor < minMinor) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.BELOW_MINIMUM,
        `Minimum withdrawal for ${currency} is ${formatMinorToApi(minMinor, currency)}`,
      );
    }
  }

  private async _requireWithdrawal(
    withdrawalId: string,
  ): Promise<WithdrawalEntity> {
    const [row] = await this._databaseService.db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.id, withdrawalId))
      .limit(1);
    if (!row) {
      throw new DomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Withdrawal not found',
      );
    }
    return row;
  }

  private _getDispatchLeaseMs(): number {
    const timeoutMs = this._configService.get('PROVIDER_HTTP_TIMEOUT_MS', {
      infer: true,
    });
    return computeSafeLeaseMs(
      WITHDRAWAL_DISPATCH_LEASE_MS,
      timeoutMs,
      2,
      15_000,
    );
  }

  private _getProcessingPollLeaseMs(): number {
    const timeoutMs = this._configService.get('PROVIDER_HTTP_TIMEOUT_MS', {
      infer: true,
    });
    return computeSafeLeaseMs(
      WITHDRAWAL_PROCESSING_POLL_LEASE_MS,
      timeoutMs,
      1,
      10_000,
    );
  }

  private async _claimDispatchBatch(
    limit: number,
  ): Promise<ClaimedWithdrawalDispatchItem[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this._getDispatchLeaseMs());

    return this._databaseService.runInTransaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(withdrawals)
        .where(
          or(
            eq(withdrawals.status, WithdrawalStatus.PENDING_DISPATCH),
            and(
              eq(withdrawals.status, WithdrawalStatus.DISPATCHING),
              lte(withdrawals.leaseUntil, now),
            ),
          ),
        )
        .orderBy(asc(withdrawals.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      const claimed: ClaimedWithdrawalDispatchItem[] = [];
      for (const candidate of candidates) {
        const [updated] = await tx
          .update(withdrawals)
          .set({
            status: WithdrawalStatus.DISPATCHING,
            leaseUntil,
            version: sql`${withdrawals.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(withdrawals.id, candidate.id),
              eq(withdrawals.version, candidate.version),
            ),
          )
          .returning();

        if (updated) {
          claimed.push({
            row: updated,
            wasRecovery: candidate.status === WithdrawalStatus.DISPATCHING,
            claimedVersion: updated.version,
          });
        }
      }

      return claimed;
    });
  }

  private async _dispatchSingleItem(
    item: ClaimedWithdrawalDispatchItem,
    slaMs: number,
  ): Promise<void> {
    const { row, wasRecovery, claimedVersion } = item;

    if (wasRecovery) {
      const recovery = await this._payoutClient.getTransfer(
        row.providerRequestId,
      );
      if (recovery.kind === 'FOUND') {
        if (
          detectProviderPayloadMismatch(row, {
            amount: recovery.amount,
            currency: recovery.currency,
          })
        ) {
          await this._recordPayloadMismatchAndEscalate({
            row,
            providedAmount: recovery.amount ?? null,
            providedCurrency: recovery.currency ?? null,
            status: recovery.status,
            expectedVersion: row.version,
          });
          return;
        }
        await this._applyProviderStatus(row.id, recovery.status, {
          providerRefId: recovery.providerRefId,
          reason: recovery.failureReason,
          source: 'POLLER',
          expectedVersion: row.version,
        });
        return;
      }
      if (recovery.kind === 'AMBIGUOUS') {
        await this._handleAmbiguousDispatch(row, claimedVersion, slaMs);
        return;
      }
    }

    await this._submitCreateTransfer(row, claimedVersion, slaMs, wasRecovery);
  }

  private async _submitCreateTransfer(
    row: WithdrawalEntity,
    claimedVersion: bigint,
    slaMs: number,
    wasRecovery: boolean,
  ): Promise<void> {
    const ccy = row.currency;
    const result = await this._payoutClient.createTransfer({
      requestId: row.providerRequestId,
      currency: ccy,
      amountMinor: BigInt(row.amount),
      destination: row.destination,
    });

    if (result.kind === 'ACCEPTED') {
      const now = new Date();
      await this._databaseService.db
        .update(withdrawals)
        .set({
          status: WithdrawalStatus.PROCESSING,
          providerRefId: result.trackingId,
          leaseUntil: null,
          nextPollAt: new Date(
            now.getTime() + addJitterMs(WITHDRAWAL_PROCESSING_POLL_DELAY_MS),
          ),
          version: sql`${withdrawals.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(withdrawals.id, row.id),
            eq(withdrawals.status, WithdrawalStatus.DISPATCHING),
            eq(withdrawals.version, claimedVersion),
          ),
        );
      return;
    }

    if (result.kind === 'PERMANENT_REJECTED' && !wasRecovery) {
      await this._failDispatchingWithdrawal(
        row.id,
        claimedVersion,
        result.reason,
      );
      return;
    }

    await this._handleAmbiguousDispatch(row, claimedVersion, slaMs);
  }

  private async _handleAmbiguousDispatch(
    row: WithdrawalEntity,
    claimedVersion: bigint,
    slaMs: number,
  ): Promise<void> {
    if (Date.now() - row.createdAt.getTime() >= slaMs) {
      await this._escalateDispatchingToManualReview(row.id, claimedVersion);
      return;
    }

    const attempt = Math.max(1, Number(claimedVersion - 1n));
    const delayMs = computeJitteredBackoffMs(attempt, 1_500, 15_000);
    await this._databaseService.db
      .update(withdrawals)
      .set({
        leaseUntil: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(withdrawals.id, row.id),
          eq(withdrawals.status, WithdrawalStatus.DISPATCHING),
          eq(withdrawals.version, claimedVersion),
        ),
      );
  }

  private async _escalateDispatchingToManualReview(
    withdrawalId: string,
    claimedVersion: bigint,
  ): Promise<void> {
    const now = new Date();
    await this._databaseService.db
      .update(withdrawals)
      .set({
        status: WithdrawalStatus.MANUAL_REVIEW,
        leaseUntil: null,
        nextPollAt: new Date(
          now.getTime() + addJitterMs(WITHDRAWAL_PROCESSING_POLL_DELAY_MS),
        ),
        version: sql`${withdrawals.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(withdrawals.id, withdrawalId),
          eq(withdrawals.status, WithdrawalStatus.DISPATCHING),
          eq(withdrawals.version, claimedVersion),
        ),
      );
  }

  private async _failDispatchingWithdrawal(
    withdrawalId: string,
    claimedVersion: bigint,
    reason: string,
  ): Promise<void> {
    await this._databaseService.runInTransaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.id, withdrawalId))
        .for('update')
        .limit(1);

      if (
        !locked ||
        locked.status !== WithdrawalStatus.DISPATCHING ||
        locked.version !== claimedVersion
      ) {
        return;
      }

      await this._withdrawalLedgerService.failAndReleaseLockedWithdrawal(
        tx,
        locked,
        {
          reason,
          markTerminalReturn: false,
        },
      );
    });
  }

  private async _pollSingleProcessingRow(
    row: WithdrawalEntity,
    slaMs: number,
  ): Promise<void> {
    try {
      const inquiry = await this._payoutClient.getTransfer(
        row.providerRequestId,
      );
      if (row.status === WithdrawalStatus.FAILED) {
        await this._pollFailedLateVerificationRow(row, inquiry, slaMs);
        return;
      }
      if (inquiry.kind === 'FOUND') {
        if (
          detectProviderPayloadMismatch(row, {
            amount: inquiry.amount,
            currency: inquiry.currency,
          })
        ) {
          await this._recordPayloadMismatchAndEscalate({
            row,
            providedAmount: inquiry.amount ?? null,
            providedCurrency: inquiry.currency ?? null,
            status: inquiry.status,
            expectedVersion: row.version,
          });
          return;
        }
        const updated = await this._applyProviderStatus(
          row.id,
          inquiry.status,
          {
            providerRefId: inquiry.providerRefId,
            reason: inquiry.failureReason,
            source: 'POLLER',
            expectedVersion: row.version,
          },
        );
        if (
          updated.status === WithdrawalStatus.PROCESSING &&
          Date.now() - row.createdAt.getTime() >= slaMs
        ) {
          await this._escalateToManualReview(row.id, row.version);
        }
        return;
      }

      if (
        inquiry.kind === 'NOT_FOUND' &&
        row.status === WithdrawalStatus.MANUAL_REVIEW
      ) {
        if (row.providerRefId !== null) {
          this._logger.warn(
            `Payout returned 404 for previously accepted MANUAL_REVIEW withdrawal=${row.id} ref=${row.providerRefId}; keeping in MANUAL_REVIEW for ops triage`,
          );
          return;
        }
        await this._redispatchUnacceptedManualReview(row, slaMs);
        return;
      }

      if (
        row.status === WithdrawalStatus.PROCESSING &&
        Date.now() - row.createdAt.getTime() >= slaMs
      ) {
        await this._escalateToManualReview(row.id, row.version);
      }
    } catch (err) {
      this._logger.warn(
        `Processing poll failed for withdrawal=${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async _pollFailedLateVerificationRow(
    row: WithdrawalEntity,
    inquiry: PayoutTransferStatusResult,
    slaMs: number,
  ): Promise<void> {
    if (inquiry.kind === 'FOUND') {
      await this._handleFoundFailedLateVerification(row, inquiry, slaMs);
      return;
    }

    if (inquiry.kind === 'NOT_FOUND') {
      await this._stopFailedLateVerification(row.id, true);
      return;
    }

    if (await this._isLateVerificationExpired(row.id, slaMs)) {
      await this._stopFailedLateVerification(row.id, false);
    }
  }

  private async _handleFoundFailedLateVerification(
    row: WithdrawalEntity,
    inquiry: Extract<PayoutTransferStatusResult, { kind: 'FOUND' }>,
    slaMs: number,
  ): Promise<void> {
    if (
      detectProviderPayloadMismatch(row, {
        amount: inquiry.amount,
        currency: inquiry.currency,
      })
    ) {
      await this._recordPayloadMismatchAndEscalate({
        row,
        providedAmount: inquiry.amount ?? null,
        providedCurrency: inquiry.currency ?? null,
        status: inquiry.status,
        expectedVersion: row.version,
      });
      return;
    }

    if (inquiry.status === PayoutStatusValue.FAILED) {
      await this._stopFailedLateVerification(row.id, true);
      return;
    }

    if (
      inquiry.status === PayoutStatusValue.PENDING ||
      inquiry.status === PayoutStatusValue.PROCESSING
    ) {
      if (await this._isLateVerificationExpired(row.id, slaMs)) {
        await this._stopFailedLateVerification(row.id, false);
      }
      return;
    }

    await this._applyProviderStatus(row.id, inquiry.status, {
      providerRefId: inquiry.providerRefId,
      reason: inquiry.failureReason,
      source: 'POLLER',
      expectedVersion: row.version,
    });
  }

  private async _redispatchUnacceptedManualReview(
    row: WithdrawalEntity,
    slaMs: number,
  ): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this._getDispatchLeaseMs());
    const [claimed] = await this._databaseService.db
      .update(withdrawals)
      .set({
        status: WithdrawalStatus.DISPATCHING,
        leaseUntil,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(withdrawals.id, row.id),
          eq(withdrawals.status, WithdrawalStatus.MANUAL_REVIEW),
          isNull(withdrawals.providerRefId),
          eq(withdrawals.version, row.version),
        ),
      )
      .returning();

    if (!claimed) {
      return;
    }

    await this._submitCreateTransfer(claimed, claimed.version, slaMs, true);
  }

  private async _escalateToManualReview(
    withdrawalId: string,
    expectedVersion: bigint,
  ): Promise<void> {
    await this._databaseService.db
      .update(withdrawals)
      .set({
        status: WithdrawalStatus.MANUAL_REVIEW,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(withdrawals.id, withdrawalId),
          eq(withdrawals.status, WithdrawalStatus.PROCESSING),
          eq(withdrawals.version, expectedVersion),
        ),
      );
  }

  private async _applyProviderStatus(
    withdrawalId: string,
    providerStatus: PayoutStatusValue,
    meta: {
      providerRefId: string | null;
      reason: string | null;
      source: 'WEBHOOK' | 'POLLER';
      expectedVersion?: bigint;
    },
  ): Promise<WithdrawalResponseDto> {
    const preRead = await this._requireWithdrawal(withdrawalId);
    const ccy = preRead.currency;

    if (
      providerStatus === PayoutStatusValue.SUCCEEDED ||
      providerStatus === PayoutStatusValue.RETURNED ||
      providerStatus === PayoutStatusValue.REVERSED
    ) {
      await this._walletService.ensureUserScaffold({
        accountSpecs: [
          {
            userId: preRead.userId,
            currency: ccy,
            accountType: UserAccountType.AVAILABLE,
          },
          {
            userId: preRead.userId,
            currency: Currency.IRT,
            accountType: UserAccountType.RECEIVABLE,
          },
          {
            userId: preRead.userId,
            currency: Currency.USDT,
            accountType: UserAccountType.RECEIVABLE,
          },
        ],
        dailyLimitKeys: [
          { userId: preRead.userId, limitDate: preRead.limitDate },
        ],
        restrictionUserIds: [preRead.userId],
      });
    }

    const txOutcome = await this._databaseService.runInTransaction(
      async (tx) => {
        const [locked] = await tx
          .select()
          .from(withdrawals)
          .where(eq(withdrawals.id, withdrawalId))
          .for('update')
          .limit(1);

        if (!locked) {
          throw new DomainException(
            HttpStatus.NOT_FOUND,
            ErrorCode.NOT_FOUND,
            'Withdrawal not found',
          );
        }

        if (
          meta.expectedVersion !== undefined &&
          locked.version !== meta.expectedVersion
        ) {
          return { kind: 'DONE' as const, row: locked };
        }

        return this._routeLockedStatusTransition(
          tx,
          locked,
          providerStatus,
          meta,
        );
      },
    );

    if (txOutcome.kind === 'NEEDS_AUTHORITATIVE_VERIFY') {
      return this._verifyLateSuccessAgainstProvider(
        txOutcome.row,
        meta.providerRefId,
      );
    }

    return toWithdrawalResponseDto(txOutcome.row);
  }

  private async _verifyLateSuccessAgainstProvider(
    row: WithdrawalEntity,
    fallbackRefId: string | null,
  ): Promise<WithdrawalResponseDto> {
    const inquiry = await this._payoutClient.getTransfer(row.providerRequestId);
    if (inquiry.kind === 'FOUND') {
      await this._applyFoundLateVerification(row, inquiry, fallbackRefId);
    } else if (inquiry.kind === 'NOT_FOUND') {
      await this._stopFailedLateVerification(row.id, true);
    }

    const latest = await this._requireWithdrawal(row.id);
    if (
      latest.status === WithdrawalStatus.FAILED &&
      latest.nextPollAt !== null
    ) {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        'Late payout success is pending provider verification',
      );
    }
    return toWithdrawalResponseDto(latest);
  }

  private async _applyFoundLateVerification(
    row: WithdrawalEntity,
    inquiry: Extract<PayoutTransferStatusResult, { kind: 'FOUND' }>,
    fallbackRefId: string | null,
  ): Promise<void> {
    if (detectProviderPayloadMismatch(row, inquiry)) {
      await this._recordPayloadMismatchAndEscalate({
        row,
        providedAmount: inquiry.amount ?? null,
        providedCurrency: inquiry.currency ?? null,
        status: inquiry.status,
      });
      return;
    }

    if (inquiry.status === PayoutStatusValue.FAILED) {
      await this._stopFailedLateVerification(row.id, true);
      return;
    }

    if (
      inquiry.status === PayoutStatusValue.PENDING ||
      inquiry.status === PayoutStatusValue.PROCESSING
    ) {
      return;
    }

    await this._applyProviderStatus(row.id, inquiry.status, {
      providerRefId: inquiry.providerRefId ?? fallbackRefId,
      reason: inquiry.failureReason,
      source: 'POLLER',
    });
  }

  private async _scheduleLateSuccessVerification(
    tx: DbTransaction,
    locked: WithdrawalEntity,
  ): Promise<void> {
    if (locked.nextPollAt !== null) {
      return;
    }
    const now = new Date();
    await tx
      .update(withdrawals)
      .set({
        nextPollAt: new Date(
          now.getTime() + WITHDRAWAL_PROCESSING_POLL_DELAY_MS,
        ),
      })
      .where(eq(withdrawals.id, locked.id));
    await tx
      .insert(financialDiscrepancies)
      .values({
        id: generateUuidV7(),
        referenceType: DiscrepancyRefType.WITHDRAWAL,
        referenceId: locked.id,
        userId: locked.userId,
        discrepancyType: DiscrepancyType.LATE_SUCCESS_VERIFICATION,
        amount: locked.amount,
        currency: locked.currency,
        status: DiscrepancyStatus.OPEN,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          financialDiscrepancies.referenceType,
          financialDiscrepancies.referenceId,
          financialDiscrepancies.discrepancyType,
        ],
        set: { status: DiscrepancyStatus.OPEN, createdAt: now },
      });
  }

  private async _stopFailedLateVerification(
    withdrawalId: string,
    resolveDiscrepancy: boolean,
  ): Promise<void> {
    await this._databaseService.runInTransaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.id, withdrawalId))
        .for('update')
        .limit(1);

      if (!locked || locked.status !== WithdrawalStatus.FAILED) {
        return;
      }

      if (locked.nextPollAt !== null) {
        await tx
          .update(withdrawals)
          .set({
            nextPollAt: null,
            leaseUntil: null,
            version: sql`${withdrawals.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(withdrawals.id, locked.id));
      }

      if (resolveDiscrepancy) {
        await tx
          .update(financialDiscrepancies)
          .set({ status: DiscrepancyStatus.RESOLVED })
          .where(
            and(
              eq(
                financialDiscrepancies.referenceType,
                DiscrepancyRefType.WITHDRAWAL,
              ),
              eq(financialDiscrepancies.referenceId, locked.id),
              eq(
                financialDiscrepancies.discrepancyType,
                DiscrepancyType.LATE_SUCCESS_VERIFICATION,
              ),
              eq(financialDiscrepancies.status, DiscrepancyStatus.OPEN),
            ),
          );
      }
    });
  }

  private async _isLateVerificationExpired(
    withdrawalId: string,
    slaMs: number,
  ): Promise<boolean> {
    const [row] = await this._databaseService.db
      .select({ createdAt: financialDiscrepancies.createdAt })
      .from(financialDiscrepancies)
      .where(
        and(
          eq(
            financialDiscrepancies.referenceType,
            DiscrepancyRefType.WITHDRAWAL,
          ),
          eq(financialDiscrepancies.referenceId, withdrawalId),
          eq(
            financialDiscrepancies.discrepancyType,
            DiscrepancyType.LATE_SUCCESS_VERIFICATION,
          ),
          eq(financialDiscrepancies.status, DiscrepancyStatus.OPEN),
        ),
      )
      .limit(1);

    return row ? Date.now() - row.createdAt.getTime() >= slaMs : true;
  }

  private async _routeLockedStatusTransition(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    providerStatus: PayoutStatusValue,
    meta: {
      providerRefId: string | null;
      reason: string | null;
      source: 'WEBHOOK' | 'POLLER';
    },
  ): Promise<
    | { kind: 'DONE'; row: WithdrawalEntity }
    | { kind: 'NEEDS_AUTHORITATIVE_VERIFY'; row: WithdrawalEntity }
  > {
    const hasPrior =
      locked.status === WithdrawalStatus.FAILED &&
      providerStatus === PayoutStatusValue.SUCCEEDED
        ? await this._withdrawalLedgerService.hasPriorSettlementOrReturn(
            tx,
            locked.id,
          )
        : false;

    const action = decideWithdrawalTransition(
      {
        status: toWithdrawalStatus(locked.status),
        failureReason: locked.failureReason,
        terminalReturn: locked.terminalReturn,
        lateSuccessConflict: locked.lateSuccessConflict,
        hasPriorSettlementOrReturn: hasPrior,
        authoritativeConfirmed: meta.source === 'POLLER',
      },
      { kind: 'PROVIDER_STATUS', status: providerStatus },
    );

    switch (action.kind) {
      case 'NOOP':
      case 'INVALID_TRANSITION':
        return { kind: 'DONE', row: locked };
      case 'NEEDS_AUTHORITATIVE_VERIFY':
        await this._scheduleLateSuccessVerification(tx, locked);
        return { kind: 'NEEDS_AUTHORITATIVE_VERIFY', row: locked };
      case 'ADVANCE_TO_PROCESSING':
        return {
          kind: 'DONE',
          row: await this._advanceToProcessingIfDispatching(
            tx,
            locked,
            meta.providerRefId,
          ),
        };
      case 'SETTLE':
        return {
          kind: 'DONE',
          row: await this._withdrawalLedgerService.settleLockedWithdrawal(
            tx,
            locked,
            {
              providerRefId: meta.providerRefId,
            },
          ),
        };
      case 'FAIL_AND_RELEASE': {
        const defaultReason =
          providerStatus === PayoutStatusValue.RETURNED ||
          providerStatus === PayoutStatusValue.REVERSED
            ? WithdrawalFailureReason.BANK_RETURNED
            : WithdrawalFailureReason.PROVIDER_FAILED;
        return {
          kind: 'DONE',
          row: await this._withdrawalLedgerService.failAndReleaseLockedWithdrawal(
            tx,
            locked,
            {
              reason: meta.reason ?? defaultReason,
              markTerminalReturn: action.markTerminalReturn,
            },
          ),
        };
      }
      case 'REVERSE_SUCCEEDED':
        return {
          kind: 'DONE',
          row: await this._withdrawalLedgerService.reverseSucceededWithdrawal(
            tx,
            locked,
            meta.reason ?? WithdrawalFailureReason.BANK_RETURNED,
          ),
        };
      case 'MARK_TERMINAL_RETURN_ONLY':
        await this._resolveWithdrawalDiscrepancies(tx, locked.id);
        return {
          kind: 'DONE',
          row: await this._withdrawalLedgerService.markTerminalReturnOnly(
            tx,
            locked,
            meta.reason ?? WithdrawalFailureReason.BANK_RETURNED,
          ),
        };
      case 'LATE_SUCCESS_CLAWBACK':
        await this._resolveWithdrawalDiscrepancies(tx, locked.id);
        return {
          kind: 'DONE',
          row: await this._withdrawalLedgerService.handleLateSuccessConflict(
            tx,
            locked,
            meta,
          ),
        };
    }
  }

  private async _advanceToProcessingIfDispatching(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    providerRefId: string | null,
  ): Promise<WithdrawalEntity> {
    if (locked.status !== WithdrawalStatus.DISPATCHING) {
      return locked;
    }
    const now = new Date();
    const [updated] = await tx
      .update(withdrawals)
      .set({
        status: WithdrawalStatus.PROCESSING,
        providerRefId: providerRefId ?? locked.providerRefId,
        leaseUntil: null,
        nextPollAt: new Date(
          now.getTime() + addJitterMs(WITHDRAWAL_PROCESSING_POLL_DELAY_MS),
        ),
        version: sql`${withdrawals.version} + 1`,
        updatedAt: now,
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();

    return updated ?? locked;
  }

  private async _resolveWithdrawalDiscrepancies(
    tx: DbTransaction,
    id: string,
  ): Promise<void> {
    await tx
      .update(financialDiscrepancies)
      .set({ status: DiscrepancyStatus.RESOLVED })
      .where(
        and(
          eq(
            financialDiscrepancies.referenceType,
            DiscrepancyRefType.WITHDRAWAL,
          ),
          eq(financialDiscrepancies.referenceId, id),
          inArray(financialDiscrepancies.discrepancyType, [
            DiscrepancyType.PAYOUT_PAYLOAD_MISMATCH,
            DiscrepancyType.LATE_SUCCESS_VERIFICATION,
          ]),
          eq(financialDiscrepancies.status, DiscrepancyStatus.OPEN),
        ),
      );
  }

  private async _assertCurrencyNotPaused(
    tx: DbTransaction,
    currency: Currency,
  ): Promise<void> {
    const [control] = await tx
      .select({ value: systemControls.value })
      .from(systemControls)
      .where(eq(systemControls.key, PAUSED_WITHDRAWALS_CONTROL_KEY))
      .limit(1);

    const pausedRaw = control?.value?.currencies;
    if (Array.isArray(pausedRaw) && pausedRaw.includes(currency)) {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_PAUSED,
        `Withdrawals are temporarily paused for ${currency}`,
      );
    }
  }

  private async _recordPayloadMismatchAndEscalate(params: {
    row: WithdrawalEntity;
    providedAmount: string | number | null;
    providedCurrency: string | null;
    status: string | null;
    expectedVersion?: bigint;
  }): Promise<WithdrawalEntity> {
    const { row } = params;
    const expectedCurrency = row.currency;

    this._logger.warn(
      `Payout payload mismatch for withdrawal=${row.id} req=${row.providerRequestId}; halting settlement and escalating to MANUAL_REVIEW`,
    );

    return this._databaseService.runInTransaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.id, row.id))
        .for('update')
        .limit(1);

      const target = locked ?? row;
      if (
        params.expectedVersion !== undefined &&
        target.version !== params.expectedVersion
      ) {
        return target;
      }
      await tx
        .insert(financialDiscrepancies)
        .values({
          id: generateUuidV7(),
          referenceType: DiscrepancyRefType.WITHDRAWAL,
          referenceId: target.id,
          userId: target.userId,
          discrepancyType: DiscrepancyType.PAYOUT_PAYLOAD_MISMATCH,
          amount: target.amount,
          currency: expectedCurrency,
          providerPayload: {
            expectedAmount: target.amount,
            expectedCurrency,
            providedAmount: params.providedAmount,
            providedCurrency: params.providedCurrency,
            status: params.status,
            providerRequestId: target.providerRequestId,
          },
          status: DiscrepancyStatus.OPEN,
        })
        .onConflictDoNothing({
          target: [
            financialDiscrepancies.referenceType,
            financialDiscrepancies.referenceId,
            financialDiscrepancies.discrepancyType,
          ],
        });

      if (
        target.status === WithdrawalStatus.DISPATCHING ||
        target.status === WithdrawalStatus.PROCESSING ||
        target.status === WithdrawalStatus.MANUAL_REVIEW
      ) {
        const [escalated] = await tx
          .update(withdrawals)
          .set({
            status: WithdrawalStatus.MANUAL_REVIEW,
            leaseUntil: null,
            nextPollAt: null,
            version: sql`${withdrawals.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(withdrawals.id, target.id))
          .returning();
        return escalated ?? target;
      }

      if (target.status === WithdrawalStatus.FAILED) {
        await tx
          .update(financialDiscrepancies)
          .set({ status: DiscrepancyStatus.RESOLVED })
          .where(
            and(
              eq(
                financialDiscrepancies.referenceType,
                DiscrepancyRefType.WITHDRAWAL,
              ),
              eq(financialDiscrepancies.referenceId, target.id),
              eq(
                financialDiscrepancies.discrepancyType,
                DiscrepancyType.LATE_SUCCESS_VERIFICATION,
              ),
              eq(financialDiscrepancies.status, DiscrepancyStatus.OPEN),
            ),
          );
        const [halted] = await tx
          .update(withdrawals)
          .set({
            leaseUntil: null,
            nextPollAt: null,
            version: sql`${withdrawals.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(withdrawals.id, target.id))
          .returning();
        return halted ?? target;
      }

      return target;
    });
  }

  private readonly _logger = new Logger(WithdrawalService.name);
}
