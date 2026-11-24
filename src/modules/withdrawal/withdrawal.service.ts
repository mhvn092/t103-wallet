import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { PAUSED_WITHDRAWALS_CONTROL_KEY } from '../../common/constants/system-controls.constants.js';
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
  type Currency,
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
  ledgerTransactions,
  systemControls,
  userRestrictions,
  withdrawals,
} from '../../database/schema/index.js';
import type { IdempotentExecutionResult } from '../idempotency/idempotency.types.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { LedgerPostingLine } from '../ledger/ledger.types.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { verifyHmacSha256Hex } from '../providers/hmac.util.js';
import { PayoutClient } from '../providers/payout.client.js';
import type { PayoutStatusValue } from '../providers/provider.types.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { WithdrawalCreateDto } from './dto/withdrawal-create.dto.js';
import type {
  WithdrawalResponseDto,
  WithdrawalWebhookAckDto,
} from './dto/withdrawal-response.dto.js';
import {
  WITHDRAWAL_DISPATCH_LEASE_MS,
  WITHDRAWAL_PROCESSING_POLL_DELAY_MS,
  WITHDRAWAL_PROCESSING_POLL_LEASE_MS,
} from './withdrawal.constants.js';
import {
  computeWithdrawalPolicyAmounts,
  isWebhookAmountValid,
  toWithdrawalResponseDto,
} from './withdrawal.mapper.js';
import {
  type PayoutWebhookPayload,
  payoutWebhookPayloadSchema,
} from './withdrawal.schemas.js';
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
    private readonly _ledgerService: LedgerService,
    private readonly _payoutClient: PayoutClient,
  ) {}

  async createWithdrawal(params: {
    idempotencyKey: string;
    dto: WithdrawalCreateDto;
  }): Promise<IdempotentExecutionResult<WithdrawalResponseDto>> {
    const { dto } = params;
    const limitDate = getTehranDateString();
    const availableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: 'AVAILABLE' as const,
    };
    const lockedSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: 'LOCKED' as const,
    };
    const receivableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: 'RECEIVABLE' as const,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec, lockedSpec, receivableSpec],
      dailyLimitKeys: [{ userId: dto.userId, limitDate }],
      restrictionUserIds: [dto.userId],
    });

    return this._idempotencyService.executeInTransaction<WithdrawalResponseDto>(
      {
        scope: `POST:/withdrawals:${dto.userId}`,
        key: params.idempotencyKey,
        requestBody: dto,
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

          await this._walletService.addDailyLimitUsage(
            tx,
            dto.userId,
            limitDate,
            policy.irtEquivalent,
          );

          const withdrawalId = generateUuidV7();
          const [inserted] = await tx
            .insert(withdrawals)
            .values({
              id: withdrawalId,
              userId: dto.userId,
              currency: dto.currency,
              amount: amountMinor.toString(),
              fee: policy.feeMinor.toString(),
              fxRateIrt: policy.fxRateIrt.toString(),
              irtEquivalent: policy.irtEquivalent.toString(),
              limitDate,
              quotaReleased: false,
              destination: normalizedDest,
              providerRequestId: `wd_${withdrawalId}`,
              status: 'PENDING_DISPATCH',
              lateSuccessConflict: false,
              version: 1n,
            })
            .returning();

          if (!inserted) {
            throw new DomainException(
              HttpStatus.INTERNAL_SERVER_ERROR,
              ErrorCode.INTERNAL_ERROR,
              'Failed to create withdrawal record',
            );
          }

          await this._ledgerService.postTransaction(tx, {
            type: 'WD_HOLD',
            referenceType: 'WITHDRAWAL',
            referenceId: withdrawalId,
            description: `Withdrawal hold for ${dto.currency} payout`,
            metadata: {
              currency: dto.currency,
              destination: normalizedDest,
              fee: formatMinorToApi(policy.feeMinor, dto.currency),
            },
            postings: [
              {
                account: userAvailable,
                direction: 'DEBIT',
                amount: totalHold,
              },
              {
                account: userLocked,
                direction: 'CREDIT',
                amount: totalHold,
              },
            ],
          });

          return toWithdrawalResponseDto(inserted);
        },
      },
    );
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalResponseDto> {
    const validId = assertValidUuid(withdrawalId, 'withdrawalId');
    const row = await this._requireWithdrawal(validId);
    return toWithdrawalResponseDto(row);
  }

  async cancelWithdrawal(withdrawalId: string): Promise<WithdrawalResponseDto> {
    const validId = assertValidUuid(withdrawalId, 'withdrawalId');

    const updated = await this._databaseService.runInTransaction(async (tx) => {
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

      if (
        locked.status === 'FAILED' &&
        locked.failureReason === 'CANCELLED_BY_USER'
      ) {
        return locked;
      }

      if (locked.status !== 'PENDING_DISPATCH') {
        throw new DomainException(
          HttpStatus.CONFLICT,
          ErrorCode.INVALID_STATE_TRANSITION,
          `Cannot cancel withdrawal in status ${locked.status}`,
        );
      }

      return this._transitionLockedToFailedAndRelease(
        tx,
        locked,
        'CANCELLED_BY_USER',
      );
    });

    return toWithdrawalResponseDto(updated);
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

    await this._checkWebhookPayloadMismatch(row, parsed.data);

    const updated = await this._applyProviderStatus(
      row.id,
      parsed.data.status,
      {
        providerRefId: parsed.data.refId ?? parsed.data.trackingId ?? null,
        reason: parsed.data.reason ?? parsed.data.failureReason ?? null,
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
              inArray(withdrawals.status, ['PROCESSING', 'MANUAL_REVIEW']),
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
        await tx
          .update(withdrawals)
          .set({
            nextPollAt: new Date(
              now.getTime() + addPositiveJitterMs(pollLeaseMs),
            ),
            updatedAt: now,
          })
          .where(inArray(withdrawals.id, ids));

        return due;
      },
    );

    for (const row of claimedRows) {
      await this._pollSingleProcessingRow(row, slaMs);
    }

    return claimedRows.length;
  }

  private _assertAboveMinimum(amountMinor: bigint, currency: Currency): void {
    const minStr =
      currency === 'IRT'
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
            eq(withdrawals.status, 'PENDING_DISPATCH'),
            and(
              eq(withdrawals.status, 'DISPATCHING'),
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
            status: 'DISPATCHING',
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
            wasRecovery: candidate.status === 'DISPATCHING',
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
        await this._applyProviderStatus(row.id, recovery.status, {
          providerRefId: recovery.providerRefId,
          reason: recovery.failureReason,
        });
        return;
      }
      if (recovery.kind === 'AMBIGUOUS') {
        await this._handleAmbiguousDispatch(row, claimedVersion, slaMs);
        return;
      }
    }

    await this._submitCreateTransfer(row, claimedVersion, slaMs);
  }

  private async _submitCreateTransfer(
    row: WithdrawalEntity,
    claimedVersion: bigint,
    slaMs: number,
  ): Promise<void> {
    const ccy: Currency = row.currency === 'USDT' ? 'USDT' : 'IRT';
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
          status: 'PROCESSING',
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
            eq(withdrawals.status, 'DISPATCHING'),
            eq(withdrawals.version, claimedVersion),
          ),
        );
      return;
    }

    if (result.kind === 'PERMANENT_REJECTED') {
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
          eq(withdrawals.status, 'DISPATCHING'),
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
        status: 'MANUAL_REVIEW',
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
          eq(withdrawals.status, 'DISPATCHING'),
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
        locked.status !== 'DISPATCHING' ||
        locked.version !== claimedVersion
      ) {
        return;
      }

      await this._transitionLockedToFailedAndRelease(tx, locked, reason);
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
      if (inquiry.kind === 'FOUND') {
        const updated = await this._applyProviderStatus(
          row.id,
          inquiry.status,
          {
            providerRefId: inquiry.providerRefId,
            reason: inquiry.failureReason,
          },
        );
        if (
          updated.status === 'PROCESSING' &&
          Date.now() - row.createdAt.getTime() >= slaMs
        ) {
          await this._escalateToManualReview(row.id);
        }
        return;
      }

      if (inquiry.kind === 'NOT_FOUND' && row.status === 'MANUAL_REVIEW') {
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
        row.status === 'PROCESSING' &&
        Date.now() - row.createdAt.getTime() >= slaMs
      ) {
        await this._escalateToManualReview(row.id);
      }
    } catch (err) {
      this._logger.warn(
        `Processing poll failed for withdrawal=${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
        status: 'DISPATCHING',
        leaseUntil,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(withdrawals.id, row.id),
          eq(withdrawals.status, 'MANUAL_REVIEW'),
          isNull(withdrawals.providerRefId),
          eq(withdrawals.version, row.version),
        ),
      )
      .returning();

    if (!claimed) {
      return;
    }

    await this._submitCreateTransfer(claimed, claimed.version, slaMs);
  }

  private async _escalateToManualReview(withdrawalId: string): Promise<void> {
    await this._databaseService.db
      .update(withdrawals)
      .set({
        status: 'MANUAL_REVIEW',
        version: sql`${withdrawals.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(withdrawals.id, withdrawalId),
          eq(withdrawals.status, 'PROCESSING'),
        ),
      );
  }

  private async _applyProviderStatus(
    withdrawalId: string,
    providerStatus: PayoutStatusValue,
    meta: { providerRefId: string | null; reason: string | null },
  ): Promise<WithdrawalResponseDto> {
    const preRead = await this._requireWithdrawal(withdrawalId);
    const ccy: Currency = preRead.currency === 'USDT' ? 'USDT' : 'IRT';

    if (
      providerStatus === 'SUCCEEDED' ||
      providerStatus === 'RETURNED' ||
      providerStatus === 'REVERSED'
    ) {
      await this._walletService.ensureUserScaffold({
        accountSpecs: [
          { userId: preRead.userId, currency: ccy, accountType: 'AVAILABLE' },
          {
            userId: preRead.userId,
            currency: 'IRT',
            accountType: 'RECEIVABLE',
          },
          {
            userId: preRead.userId,
            currency: 'USDT',
            accountType: 'RECEIVABLE',
          },
        ],
        dailyLimitKeys: [
          { userId: preRead.userId, limitDate: preRead.limitDate },
        ],
        restrictionUserIds: [preRead.userId],
      });
    }

    const updated = await this._databaseService.runInTransaction(async (tx) => {
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

      return this._routeLockedStatusTransition(
        tx,
        locked,
        providerStatus,
        meta,
      );
    });

    return toWithdrawalResponseDto(updated);
  }

  private async _routeLockedStatusTransition(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    providerStatus: PayoutStatusValue,
    meta: { providerRefId: string | null; reason: string | null },
  ): Promise<WithdrawalEntity> {
    if (providerStatus === 'PENDING' || providerStatus === 'PROCESSING') {
      return this._advanceToProcessingIfDispatching(
        tx,
        locked,
        meta.providerRefId,
      );
    }

    if (providerStatus === 'SUCCEEDED') {
      if (locked.status === 'SUCCEEDED') {
        return locked;
      }
      if (locked.status === 'FAILED') {
        if (
          locked.failureReason === 'CANCELLED_BY_USER' ||
          (await this._hasPriorSettlementOrReturn(tx, locked.id))
        ) {
          return locked;
        }
        return this._handleLateSuccessConflict(tx, locked, meta);
      }
      if (
        locked.status === 'DISPATCHING' ||
        locked.status === 'PROCESSING' ||
        locked.status === 'MANUAL_REVIEW'
      ) {
        return this._settleLockedWithdrawal(tx, locked, meta.providerRefId);
      }
      return locked;
    }

    if (providerStatus === 'FAILED') {
      if (
        locked.status === 'DISPATCHING' ||
        locked.status === 'PROCESSING' ||
        locked.status === 'MANUAL_REVIEW'
      ) {
        return this._transitionLockedToFailedAndRelease(
          tx,
          locked,
          meta.reason ?? 'PROVIDER_FAILED',
        );
      }
      return locked;
    }

    // RETURNED | REVERSED
    if (locked.status === 'SUCCEEDED') {
      return this._reverseSucceededWithdrawal(
        tx,
        locked,
        meta.reason ?? 'BANK_RETURNED',
      );
    }
    if (
      locked.status === 'DISPATCHING' ||
      locked.status === 'PROCESSING' ||
      locked.status === 'MANUAL_REVIEW'
    ) {
      return this._transitionLockedToFailedAndRelease(
        tx,
        locked,
        meta.reason ?? 'BANK_RETURNED',
      );
    }
    return locked;
  }

  private async _advanceToProcessingIfDispatching(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    providerRefId: string | null,
  ): Promise<WithdrawalEntity> {
    if (locked.status !== 'DISPATCHING') {
      return locked;
    }
    const now = new Date();
    const [updated] = await tx
      .update(withdrawals)
      .set({
        status: 'PROCESSING',
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

  private async _settleLockedWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    providerRefId: string | null,
  ): Promise<WithdrawalEntity> {
    const ccy: Currency = locked.currency === 'USDT' ? 'USDT' : 'IRT';
    const lockedSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'LOCKED' as const,
    };

    const lockedAccounts = await this._walletService.lockUserAccountsCanonical(
      tx,
      [lockedSpec],
    );
    const userLocked = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      lockedSpec,
    );
    const payoutClearing = await this._walletService.getSystemAccount(
      tx,
      'PAYOUT_CLEARING',
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const postings: LedgerPostingLine[] = [
      {
        account: userLocked,
        direction: 'DEBIT',
        amount: amountMinor + feeMinor,
      },
      {
        account: payoutClearing,
        direction: 'CREDIT',
        amount: amountMinor,
      },
    ];

    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        'FEE_REVENUE',
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: 'CREDIT',
        amount: feeMinor,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: 'WD_SETTLE',
      referenceType: 'WITHDRAWAL',
      referenceId: locked.id,
      description: `Withdrawal settled via payout provider (${locked.providerRequestId})`,
      metadata: {
        providerRequestId: locked.providerRequestId,
        providerRefId,
      },
      postings,
    });

    const [updated] = await tx
      .update(withdrawals)
      .set({
        status: 'SUCCEEDED',
        providerRefId: providerRefId ?? locked.providerRefId,
        leaseUntil: null,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();

    return updated ?? locked;
  }

  private async _transitionLockedToFailedAndRelease(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    reason: string,
  ): Promise<WithdrawalEntity> {
    const ccy: Currency = locked.currency === 'USDT' ? 'USDT' : 'IRT';
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'AVAILABLE' as const,
    };
    const lockedSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'LOCKED' as const,
    };

    await this._walletService.lockDailyLimit(
      tx,
      locked.userId,
      locked.limitDate,
    );
    await this._walletService.lockUserRestriction(tx, locked.userId);
    const lockedAccounts = await this._walletService.lockUserAccountsCanonical(
      tx,
      [availableSpec, lockedSpec],
    );
    const userAvailable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      availableSpec,
    );
    const userLocked = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      lockedSpec,
    );

    const totalHold = BigInt(locked.amount) + BigInt(locked.fee);
    await this._ledgerService.postTransaction(tx, {
      type: 'WD_RELEASE',
      referenceType: 'WITHDRAWAL',
      referenceId: locked.id,
      description: `Release locked funds for failed/cancelled withdrawal (${reason})`,
      metadata: { reason },
      postings: [
        { account: userLocked, direction: 'DEBIT', amount: totalHold },
        { account: userAvailable, direction: 'CREDIT', amount: totalHold },
      ],
    });

    if (!locked.quotaReleased) {
      await this._walletService.addDailyLimitUsage(
        tx,
        locked.userId,
        locked.limitDate,
        -BigInt(locked.irtEquivalent),
      );
    }

    const [updated] = await tx
      .update(withdrawals)
      .set({
        status: 'FAILED',
        failureReason: reason,
        quotaReleased: true,
        leaseUntil: null,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();

    return updated ?? locked;
  }

  private async _reverseSucceededWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    reason: string,
  ): Promise<WithdrawalEntity> {
    const ccy: Currency = locked.currency === 'USDT' ? 'USDT' : 'IRT';
    const otherCcy: Currency = ccy === 'IRT' ? 'USDT' : 'IRT';
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'AVAILABLE' as const,
    };
    const receivableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'RECEIVABLE' as const,
    };
    const otherReceivableSpec = {
      userId: locked.userId,
      currency: otherCcy,
      accountType: 'RECEIVABLE' as const,
    };

    await this._walletService.lockDailyLimit(
      tx,
      locked.userId,
      locked.limitDate,
    );
    await this._walletService.lockUserRestriction(tx, locked.userId);
    const lockedAccounts = await this._walletService.lockUserAccountsCanonical(
      tx,
      [availableSpec, receivableSpec, otherReceivableSpec],
    );
    const userAvailable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      availableSpec,
    );
    const userReceivable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      receivableSpec,
    );
    const otherReceivable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      otherReceivableSpec,
    );
    const payoutClearing = await this._walletService.getSystemAccount(
      tx,
      'PAYOUT_CLEARING',
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const totalRefund = amountMinor + feeMinor;
    const currentReceivable = BigInt(userReceivable.balance ?? '0');
    const receivableCredit =
      currentReceivable >= totalRefund ? totalRefund : currentReceivable;
    const availableCredit = totalRefund - receivableCredit;

    const postings: LedgerPostingLine[] = [
      { account: payoutClearing, direction: 'DEBIT', amount: amountMinor },
    ];
    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        'FEE_REVENUE',
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: 'DEBIT',
        amount: feeMinor,
      });
    }
    if (receivableCredit > 0n) {
      postings.push({
        account: userReceivable,
        direction: 'CREDIT',
        amount: receivableCredit,
      });
    }
    if (availableCredit > 0n) {
      postings.push({
        account: userAvailable,
        direction: 'CREDIT',
        amount: availableCredit,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: 'WD_RETURN',
      referenceType: 'WITHDRAWAL',
      referenceId: locked.id,
      description: `Bank reversal / return for withdrawal (${reason})`,
      metadata: {
        reason,
        providerRefId: locked.providerRefId,
        receivableOffset: receivableCredit.toString(),
      },
      postings,
    });

    if (
      receivableCredit > 0n &&
      currentReceivable - receivableCredit === 0n &&
      BigInt(otherReceivable.balance ?? '0') === 0n
    ) {
      await tx
        .update(userRestrictions)
        .set({
          outboundFrozen: false,
          freezeReason: null,
          updatedAt: new Date(),
        })
        .where(eq(userRestrictions.userId, locked.userId));
    }

    if (!locked.quotaReleased) {
      await this._walletService.addDailyLimitUsage(
        tx,
        locked.userId,
        locked.limitDate,
        -BigInt(locked.irtEquivalent),
      );
    }

    const [updated] = await tx
      .update(withdrawals)
      .set({
        status: 'FAILED',
        failureReason: reason,
        quotaReleased: true,
        leaseUntil: null,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();

    return updated ?? locked;
  }

  private async _hasPriorSettlementOrReturn(
    tx: DbTransaction,
    withdrawalId: string,
  ): Promise<boolean> {
    const [existing] = await tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.referenceType, 'WITHDRAWAL'),
          eq(ledgerTransactions.referenceId, withdrawalId),
          inArray(ledgerTransactions.type, [
            'WD_SETTLE',
            'WD_RETURN',
            'WD_LATE_SUCCESS',
          ]),
        ),
      )
      .limit(1);
    return Boolean(existing);
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

  private async _checkWebhookPayloadMismatch(
    row: WithdrawalEntity,
    payload: PayoutWebhookPayload,
  ): Promise<void> {
    if (
      (payload.amount === undefined || payload.amount === null) &&
      !payload.currency
    ) {
      return;
    }

    const expectedCurrency: Currency = row.currency === 'USDT' ? 'USDT' : 'IRT';
    const expectedMinor = BigInt(row.amount);
    const normCcy = payload.currency?.trim().toUpperCase();

    const currencyMismatch = Boolean(
      normCcy &&
      ((expectedCurrency === 'IRT' && normCcy !== 'IRR' && normCcy !== 'IRT') ||
        (expectedCurrency === 'USDT' && normCcy !== 'USDT')),
    );

    const amountMismatch =
      payload.amount !== undefined &&
      payload.amount !== null &&
      !isWebhookAmountValid(
        expectedCurrency,
        expectedMinor,
        payload.amount,
        payload.currency,
      );

    if (!currencyMismatch && !amountMismatch) {
      return;
    }

    this._logger.warn(
      `Payout webhook payload mismatch for withdrawal=${row.id} req=${row.providerRequestId}`,
    );
    await this._databaseService.db
      .insert(financialDiscrepancies)
      .values({
        id: generateUuidV7(),
        referenceType: 'WITHDRAWAL',
        referenceId: row.id,
        userId: row.userId,
        discrepancyType: 'PAYOUT_PAYLOAD_MISMATCH',
        amount: row.amount,
        currency: expectedCurrency,
        providerPayload: {
          expectedAmount: row.amount,
          expectedCurrency,
          providedAmount: payload.amount ?? null,
          providedCurrency: payload.currency ?? null,
          status: payload.status ?? null,
          providerRequestId: row.providerRequestId,
        },
        status: 'OPEN',
      })
      .onConflictDoNothing({
        target: [
          financialDiscrepancies.referenceType,
          financialDiscrepancies.referenceId,
          financialDiscrepancies.discrepancyType,
        ],
      });
  }

  private async _handleLateSuccessConflict(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    meta: { providerRefId: string | null; reason: string | null },
  ): Promise<WithdrawalEntity> {
    if (locked.lateSuccessConflict) {
      return locked;
    }

    const ccy: Currency = locked.currency === 'USDT' ? 'USDT' : 'IRT';
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'AVAILABLE' as const,
    };
    const receivableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'RECEIVABLE' as const,
    };

    await this._walletService.lockUserRestriction(tx, locked.userId);
    const lockedAccounts = await this._walletService.lockUserAccountsCanonical(
      tx,
      [availableSpec, receivableSpec],
    );
    const userAvailable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      availableSpec,
    );
    const userReceivable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      receivableSpec,
    );
    const payoutClearing = await this._walletService.getSystemAccount(
      tx,
      'PAYOUT_CLEARING',
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const totalOutflow = amountMinor + feeMinor;
    const currentAvailable = BigInt(userAvailable.balance ?? '0');
    const clawback =
      currentAvailable >= totalOutflow ? totalOutflow : currentAvailable;
    const shortfall = totalOutflow - clawback;

    const postings: LedgerPostingLine[] = [];
    if (clawback > 0n) {
      postings.push({
        account: userAvailable,
        direction: 'DEBIT',
        amount: clawback,
      });
    }
    if (shortfall > 0n) {
      postings.push({
        account: userReceivable,
        direction: 'DEBIT',
        amount: shortfall,
      });
    }
    postings.push({
      account: payoutClearing,
      direction: 'CREDIT',
      amount: amountMinor,
    });
    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        'FEE_REVENUE',
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: 'CREDIT',
        amount: feeMinor,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: 'WD_LATE_SUCCESS',
      referenceType: 'WITHDRAWAL',
      referenceId: locked.id,
      description: `Late payout success conflict recovery (${locked.providerRequestId})`,
      metadata: {
        providerRefId: meta.providerRefId,
        clawback: clawback.toString(),
        shortfall: shortfall.toString(),
      },
      postings,
    });

    const now = new Date();
    const [updated] = await tx
      .update(withdrawals)
      .set({
        status: 'SUCCEEDED',
        lateSuccessConflict: true,
        providerRefId: meta.providerRefId ?? locked.providerRefId,
        leaseUntil: null,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt: now,
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();

    if (shortfall > 0n) {
      await tx
        .update(userRestrictions)
        .set({
          outboundFrozen: true,
          freezeReason: `Unrecovered shortfall on late-succeeded withdrawal ${locked.id}`,
          updatedAt: now,
        })
        .where(eq(userRestrictions.userId, locked.userId));
    }

    await tx
      .insert(financialDiscrepancies)
      .values({
        id: generateUuidV7(),
        referenceType: 'WITHDRAWAL',
        referenceId: locked.id,
        userId: locked.userId,
        discrepancyType: 'LATE_SUCCESS_CONFLICT',
        amount: totalOutflow.toString(),
        currency: ccy,
        providerPayload: {
          providerRequestId: locked.providerRequestId,
          providerRefId: meta.providerRefId,
          clawback: clawback.toString(),
          shortfall: shortfall.toString(),
        },
        status: 'OPEN',
      })
      .onConflictDoNothing({
        target: [
          financialDiscrepancies.referenceType,
          financialDiscrepancies.referenceId,
          financialDiscrepancies.discrepancyType,
        ],
      });

    return updated ?? locked;
  }

  private readonly _logger = new Logger(WithdrawalService.name);
}
