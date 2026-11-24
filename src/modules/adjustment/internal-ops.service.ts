import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  type Currency,
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  financialDiscrepancies,
  outboxEvents,
  systemControls,
  userRestrictions,
  withdrawals,
} from '../../database/schema/index.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { InternalMetricsResponseDto } from './dto/internal-metrics-response.dto.js';
import type {
  ReceivableSettleDto,
  ReceivableSettleResponseDto,
} from './dto/receivable-settle.dto.js';
import type {
  WithdrawalsPauseDto,
  WithdrawalsPauseResponseDto,
} from './dto/withdrawals-pause.dto.js';

const PAUSED_WITHDRAWALS_CONTROL_KEY = 'withdrawals_paused_currencies';

@Injectable()
export class InternalOpsService {
  constructor(
    private readonly _config: ConfigService<EnvConfig, true>,
    private readonly _database: DatabaseService,
    private readonly _idempotency: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
  ) {}

  async settleReceivable(params: {
    idempotencyKey: string;
    dto: ReceivableSettleDto;
    operatorId: string;
  }): Promise<IdempotentExecutionResult<ReceivableSettleResponseDto>> {
    const { dto } = params;
    const otherCcy: Currency = dto.currency === 'IRT' ? 'USDT' : 'IRT';
    const availableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: 'AVAILABLE' as const,
    };
    const receivableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: 'RECEIVABLE' as const,
    };
    const otherReceivableSpec = {
      userId: dto.userId,
      currency: otherCcy,
      accountType: 'RECEIVABLE' as const,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec, receivableSpec, otherReceivableSpec],
      restrictionUserIds: [dto.userId],
    });

    return this._idempotency.executeInTransaction<ReceivableSettleResponseDto>({
      scope: `POST:/internal/receivables/settle:${dto.userId}`,
      key: params.idempotencyKey,
      requestBody: dto,
      statusCode: HttpStatus.OK,
      handler: async (tx) => {
        const frozen = await this._walletService.lockUserRestriction(
          tx,
          dto.userId,
        );
        const lockedAccounts =
          await this._walletService.lockUserAccountsCanonical(tx, [
            availableSpec,
            receivableSpec,
            otherReceivableSpec,
          ]);
        const userAvailable = this._walletService.getRequiredLockedAccount(
          lockedAccounts,
          availableSpec,
        );
        const userReceivable = this._walletService.getRequiredLockedAccount(
          lockedAccounts,
          receivableSpec,
        );
        const otherReceivableRow = this._walletService.getRequiredLockedAccount(
          lockedAccounts,
          otherReceivableSpec,
        );

        const available = BigInt(userAvailable.balance ?? '0');
        const receivable = BigInt(userReceivable.balance ?? '0');
        const otherReceivable = BigInt(otherReceivableRow.balance ?? '0');

        const settleAmount = this._resolveSettlementAmount(
          dto,
          available,
          receivable,
        );
        const settlementId = generateUuidV7();

        await this._ledgerService.postTransaction(tx, {
          type: 'RECEIVABLE_SETTLE',
          referenceType: 'ADJUSTMENT',
          referenceId: settlementId,
          description: `Manual/ops settlement of ${dto.currency} receivable balance`,
          metadata: {
            operatorId: params.operatorId,
            currency: dto.currency,
            settledAmount: settleAmount.toString(),
          },
          postings: [
            {
              account: userAvailable,
              direction: 'DEBIT',
              amount: settleAmount,
            },
            {
              account: userReceivable,
              direction: 'CREDIT',
              amount: settleAmount,
            },
          ],
        });

        const remainingReceivable = receivable - settleAmount;
        const allCleared = remainingReceivable === 0n && otherReceivable === 0n;
        const nextFrozen = allCleared ? false : frozen;

        if (frozen && allCleared) {
          await tx
            .update(userRestrictions)
            .set({
              outboundFrozen: false,
              freezeReason: null,
              updatedAt: new Date(),
            })
            .where(eq(userRestrictions.userId, dto.userId));
        }

        return {
          settlementId,
          userId: dto.userId,
          currency: dto.currency,
          settledAmount: formatMinorToApi(settleAmount, dto.currency),
          remainingReceivable: formatMinorToApi(
            remainingReceivable,
            dto.currency,
          ),
          outboundFrozen: nextFrozen,
        };
      },
    });
  }

  async setPausedWithdrawals(
    dto: WithdrawalsPauseDto,
  ): Promise<WithdrawalsPauseResponseDto> {
    const currencies = [...new Set(dto.currencies)];
    const now = new Date();
    const [saved] = await this._database.db
      .insert(systemControls)
      .values({
        key: PAUSED_WITHDRAWALS_CONTROL_KEY,
        value: {
          currencies,
          reason: dto.reason ?? null,
        },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: systemControls.key,
        set: {
          value: {
            currencies,
            reason: dto.reason ?? null,
          },
          updatedAt: now,
        },
      })
      .returning();

    return {
      currencies,
      updatedAt: (saved?.updatedAt ?? now).toISOString(),
    };
  }

  async refreshBalanceDriftGauge(): Promise<number> {
    if (this._driftRefreshInFlight) {
      return this._driftRefreshInFlight;
    }

    const refreshPromise = this._database.pool
      .query<{ drift_count: number }>(
        `
        SELECT COUNT(*)::int AS drift_count FROM (
          SELECT a.id
          FROM accounts a
          LEFT JOIN ledger_items li ON li.account_id = a.id
          WHERE a.owner_type = 'USER'
          GROUP BY a.id, a.balance
          HAVING a.balance IS DISTINCT FROM COALESCE(
            SUM(CASE WHEN li.direction = a.normal_side THEN li.amount ELSE -li.amount END),
            0
          )
        ) drift
      `,
      )
      .then((res) => {
        const count = res.rows[0]?.drift_count ?? 0;
        this._cachedDriftCount = count;
        this._cachedDriftComputedAtMs = Date.now();
        return count;
      })
      .finally(() => {
        this._driftRefreshInFlight = null;
      });

    this._driftRefreshInFlight = refreshPromise;
    return refreshPromise;
  }

  async getMetrics(): Promise<InternalMetricsResponseDto> {
    const [
      openDiscrepancyRow,
      manualReviewRow,
      pendingOutboxRow,
      driftCount,
      pauseControl,
    ] = await Promise.all([
      this._database.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(financialDiscrepancies)
        .where(eq(financialDiscrepancies.status, 'OPEN')),
      this._database.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(withdrawals)
        .where(eq(withdrawals.status, 'MANUAL_REVIEW')),
      this._database.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(outboxEvents)
        .where(eq(outboxEvents.status, 'PENDING')),
      this._getCachedBalanceDriftAccounts(),
      this._database.db
        .select({ value: systemControls.value })
        .from(systemControls)
        .where(eq(systemControls.key, PAUSED_WITHDRAWALS_CONTROL_KEY))
        .limit(1),
    ]);

    const pausedRaw = pauseControl[0]?.value?.currencies;
    const pausedWithdrawalCurrencies: Currency[] = Array.isArray(pausedRaw)
      ? pausedRaw.filter(
          (item): item is Currency => item === 'IRT' || item === 'USDT',
        )
      : [];

    return {
      openDiscrepancies: openDiscrepancyRow[0]?.count ?? 0,
      manualReviewWithdrawals: manualReviewRow[0]?.count ?? 0,
      pendingOutboxEvents: pendingOutboxRow[0]?.count ?? 0,
      balanceDriftAccounts: driftCount,
      pausedWithdrawalCurrencies,
    };
  }

  private _getCachedBalanceDriftAccounts(): Promise<number> {
    const intervalMs = this._config.get('DRIFT_AUDIT_INTERVAL_MS', {
      infer: true,
    });
    const workersEnabled = this._config.get('WORKERS_ENABLED', {
      infer: true,
    });
    const isFresh =
      this._cachedDriftCount !== null &&
      Date.now() - this._cachedDriftComputedAtMs < intervalMs;

    if (isFresh && this._cachedDriftCount !== null) {
      return Promise.resolve(this._cachedDriftCount);
    }

    if (this._cachedDriftCount !== null && workersEnabled) {
      void this.refreshBalanceDriftGauge().catch(() => undefined);
      return Promise.resolve(this._cachedDriftCount);
    }

    return this.refreshBalanceDriftGauge();
  }

  private _resolveSettlementAmount(
    dto: ReceivableSettleDto,
    available: bigint,
    receivable: bigint,
  ): bigint {
    if (receivable <= 0n) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.INVALID_STATE_TRANSITION,
        'No outstanding receivable balance to settle',
      );
    }

    if (dto.amount !== undefined) {
      const requestedMinor = parseAmountToMinor(dto.amount, dto.currency);
      if (requestedMinor > receivable) {
        throw new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          'Requested settlement exceeds receivable balance',
        );
      }
      if (requestedMinor > available) {
        throw new DomainException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.INSUFFICIENT_FUNDS,
          'Insufficient available balance to settle receivable',
        );
      }
      return requestedMinor;
    }

    if (available <= 0n) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.INSUFFICIENT_FUNDS,
        'Insufficient available balance to settle receivable',
      );
    }

    return available < receivable ? available : receivable;
  }

  private _cachedDriftCount: number | null = null;
  private _cachedDriftComputedAtMs = 0;
  private _driftRefreshInFlight: Promise<number> | null = null;
}
