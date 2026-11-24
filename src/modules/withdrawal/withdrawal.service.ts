import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { assertValidDestination } from '../../common/utils/destination-validator.js';
import {
  type Currency,
  convertUsdtToIrtCeiling,
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.js';
import { getTehranDateString } from '../../common/utils/tehran-date.js';
import { assertValidUuid } from '../../common/utils/uuid-validation.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DbTransaction } from '../../database/database.types.js';
import {
  financialDiscrepancies,
  userRestrictions,
  withdrawals,
} from '../../database/schema/index.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../idempotency/idempotency.service.js';
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

const DISPATCH_LEASE_MS = 45_000;
const RECOVERY_RETRY_LEASE_MS = 5_000;
const PROCESSING_POLL_DELAY_MS = 3_000;
const PROCESSING_POLL_LEASE_MS = 15_000;

const payoutWebhookSchema = z.object({
  requestId: z.string().min(1).nullish(),
  status: z
    .enum([
      'PENDING',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'RETURNED',
      'REVERSED',
    ])
    .nullish(),
  trackingId: z.string().nullish(),
  refId: z.string().nullish(),
  reason: z.string().nullish(),
  failureReason: z.string().nullish(),
});

type WithdrawalRow = typeof withdrawals.$inferSelect;

interface ClaimedDispatchItem {
  row: WithdrawalRow;
  wasRecovery: boolean;
  claimedVersion: bigint;
}

@Injectable()
export class WithdrawalService {
  constructor(
    private readonly _config: ConfigService<EnvConfig, true>,
    private readonly _database: DatabaseService,
    private readonly _idempotency: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
    private readonly _payoutClient: PayoutClient,
  ) {}

  async createWithdrawal(params: {
    idempotencyKey: string;
    dto: WithdrawalCreateDto;
  }): Promise<IdempotentExecutionResult<WithdrawalResponseDto>> {
    const { dto } = params;
    const amountMinor = parseAmountToMinor(dto.amount, dto.currency);
    const normalizedDest = assertValidDestination(
      dto.destination,
      dto.currency,
    );
    this._assertAboveMinimum(amountMinor, dto.currency);

    const policy = this._computePolicyAmounts(amountMinor, dto.currency);
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

    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec, lockedSpec],
      dailyLimitKeys: [{ userId: dto.userId, limitDate }],
      restrictionUserIds: [dto.userId],
    });

    return this._idempotency.executeInTransaction<WithdrawalResponseDto>({
      scope: 'POST:/withdrawals',
      key: params.idempotencyKey,
      requestBody: dto,
      handler: async (tx) => {
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

        return this._toDto(inserted);
      },
    });
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalResponseDto> {
    const validId = assertValidUuid(withdrawalId, 'withdrawalId');
    const row = await this._requireWithdrawal(validId);
    return this._toDto(row);
  }

  async cancelWithdrawal(withdrawalId: string): Promise<WithdrawalResponseDto> {
    const validId = assertValidUuid(withdrawalId, 'withdrawalId');

    const updated = await this._database.runInTransaction(async (tx) => {
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

    return this._toDto(updated);
  }

  async dispatchPendingBatch(limit = 10): Promise<number> {
    const claimed = await this._claimDispatchBatch(limit);

    for (const item of claimed) {
      try {
        await this._dispatchSingleItem(item);
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
    const secret = this._config.get('WEBHOOK_SECRET', { infer: true });
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

    const parsed = payoutWebhookSchema.safeParse(rawJson);
    if (!parsed.success || !parsed.data.requestId || !parsed.data.status) {
      return { received: true };
    }

    const [row] = await this._database.db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.providerRequestId, parsed.data.requestId))
      .limit(1);

    if (!row) {
      return { received: true };
    }

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
    const slaMs = this._config.get('WD_MANUAL_REVIEW_SLA_MS', { infer: true });

    const claimedRows = await this._database.runInTransaction(async (tx) => {
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
      await tx
        .update(withdrawals)
        .set({
          nextPollAt: new Date(now.getTime() + PROCESSING_POLL_LEASE_MS),
          updatedAt: now,
        })
        .where(inArray(withdrawals.id, ids));

      return due;
    });

    for (const row of claimedRows) {
      await this._pollSingleProcessingRow(row, slaMs);
    }

    return claimedRows.length;
  }

  private _assertAboveMinimum(amountMinor: bigint, currency: Currency): void {
    const minStr =
      currency === 'IRT'
        ? this._config.get('MIN_WITHDRAWAL_IRT', { infer: true })
        : this._config.get('MIN_WITHDRAWAL_USDT', { infer: true });
    const minMinor = parseAmountToMinor(minStr, currency);
    if (amountMinor < minMinor) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.BELOW_MINIMUM,
        `Minimum withdrawal for ${currency} is ${formatMinorToApi(minMinor, currency)}`,
      );
    }
  }

  private _computePolicyAmounts(amountMinor: bigint, currency: Currency) {
    const dailyLimitIrt = parseAmountToMinor(
      this._config.get('DAILY_LIMIT_IRT', { infer: true }),
      'IRT',
    );
    if (currency === 'IRT') {
      return {
        feeMinor: 0n,
        fxRateIrt: 1n,
        irtEquivalent: amountMinor,
        dailyLimitIrt,
      };
    }

    const feeMinor = parseAmountToMinor(
      this._config.get('USDT_WITHDRAWAL_FEE', { infer: true }),
      'USDT',
      { allowZero: true },
    );
    const fxRateIrt = parseAmountToMinor(
      this._config.get('USDT_IRT_RATE', { infer: true }),
      'IRT',
    );
    return {
      feeMinor,
      fxRateIrt,
      irtEquivalent: convertUsdtToIrtCeiling(amountMinor, fxRateIrt),
      dailyLimitIrt,
    };
  }

  private async _requireWithdrawal(
    withdrawalId: string,
  ): Promise<WithdrawalRow> {
    const [row] = await this._database.db
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

  private async _claimDispatchBatch(
    limit: number,
  ): Promise<ClaimedDispatchItem[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + DISPATCH_LEASE_MS);

    return this._database.runInTransaction(async (tx) => {
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

      const claimed: ClaimedDispatchItem[] = [];
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

  private async _dispatchSingleItem(item: ClaimedDispatchItem): Promise<void> {
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
        await this._database.db
          .update(withdrawals)
          .set({
            leaseUntil: new Date(Date.now() + RECOVERY_RETRY_LEASE_MS),
            updatedAt: new Date(),
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
    }

    const ccy: Currency = row.currency === 'USDT' ? 'USDT' : 'IRT';
    const result = await this._payoutClient.createTransfer({
      requestId: row.providerRequestId,
      currency: ccy,
      amountMinor: BigInt(row.amount),
      destination: row.destination,
    });

    if (result.kind === 'ACCEPTED') {
      const now = new Date();
      await this._database.db
        .update(withdrawals)
        .set({
          status: 'PROCESSING',
          providerRefId: result.trackingId,
          leaseUntil: null,
          nextPollAt: new Date(now.getTime() + PROCESSING_POLL_DELAY_MS),
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
    }
  }

  private async _failDispatchingWithdrawal(
    withdrawalId: string,
    claimedVersion: bigint,
    reason: string,
  ): Promise<void> {
    await this._database.runInTransaction(async (tx) => {
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
    row: WithdrawalRow,
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

  private async _escalateToManualReview(withdrawalId: string): Promise<void> {
    await this._database.db
      .update(withdrawals)
      .set({
        status: 'MANUAL_REVIEW',
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

    if (providerStatus === 'SUCCEEDED' && preRead.status === 'FAILED') {
      await this._walletService.ensureUserScaffold({
        accountSpecs: [
          { userId: preRead.userId, currency: ccy, accountType: 'AVAILABLE' },
          { userId: preRead.userId, currency: ccy, accountType: 'RECEIVABLE' },
        ],
        restrictionUserIds: [preRead.userId],
      });
    }

    const updated = await this._database.runInTransaction(async (tx) => {
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

    return this._toDto(updated);
  }

  private async _routeLockedStatusTransition(
    tx: DbTransaction,
    locked: WithdrawalRow,
    providerStatus: PayoutStatusValue,
    meta: { providerRefId: string | null; reason: string | null },
  ): Promise<WithdrawalRow> {
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
    locked: WithdrawalRow,
    providerRefId: string | null,
  ): Promise<WithdrawalRow> {
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
        nextPollAt: new Date(now.getTime() + PROCESSING_POLL_DELAY_MS),
        version: sql`${withdrawals.version} + 1`,
        updatedAt: now,
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();

    return updated ?? locked;
  }

  private async _settleLockedWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalRow,
    providerRefId: string | null,
  ): Promise<WithdrawalRow> {
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
    locked: WithdrawalRow,
    reason: string,
  ): Promise<WithdrawalRow> {
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
    locked: WithdrawalRow,
    reason: string,
  ): Promise<WithdrawalRow> {
    const ccy: Currency = locked.currency === 'USDT' ? 'USDT' : 'IRT';
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: 'AVAILABLE' as const,
    };

    await this._walletService.lockDailyLimit(
      tx,
      locked.userId,
      locked.limitDate,
    );
    await this._walletService.lockUserRestriction(tx, locked.userId);
    const lockedAccounts = await this._walletService.lockUserAccountsCanonical(
      tx,
      [availableSpec],
    );
    const userAvailable = this._walletService.getRequiredLockedAccount(
      lockedAccounts,
      availableSpec,
    );
    const payoutClearing = await this._walletService.getSystemAccount(
      tx,
      'PAYOUT_CLEARING',
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
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
    postings.push({
      account: userAvailable,
      direction: 'CREDIT',
      amount: amountMinor + feeMinor,
    });

    await this._ledgerService.postTransaction(tx, {
      type: 'WD_RETURN',
      referenceType: 'WITHDRAWAL',
      referenceId: locked.id,
      description: `Bank reversal / return for withdrawal (${reason})`,
      metadata: { reason, providerRefId: locked.providerRefId },
      postings,
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

  private async _handleLateSuccessConflict(
    tx: DbTransaction,
    locked: WithdrawalRow,
    meta: { providerRefId: string | null; reason: string | null },
  ): Promise<WithdrawalRow> {
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

    await tx.insert(financialDiscrepancies).values({
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
    });

    return updated ?? locked;
  }

  private _toDto(row: WithdrawalRow): WithdrawalResponseDto {
    const ccy: Currency = row.currency === 'USDT' ? 'USDT' : 'IRT';
    return {
      withdrawalId: row.id,
      userId: row.userId,
      currency: ccy,
      amount: formatMinorToApi(BigInt(row.amount), ccy),
      fee: formatMinorToApi(BigInt(row.fee), ccy),
      status: row.status,
      destination: row.destination,
      providerRequestId: row.providerRequestId,
      providerRefId: row.providerRefId,
      failureReason: row.failureReason,
      lateSuccessConflict: row.lateSuccessConflict,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private readonly _logger = new Logger(WithdrawalService.name);
}
