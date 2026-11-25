import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { PAUSED_WITHDRAWALS_CONTROL_KEY } from '../../common/constants/system-controls.constants.js';
import {
  Currency,
  DiscrepancyStatus,
  LedgerDirection,
  LedgerRefType,
  LedgerTxType,
  OutboxStatus,
  UserAccountType,
  WithdrawalStatus,
} from '../../common/enums/domain.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DbExecutor } from '../../database/database.types.js';
import {
  financialDiscrepancies,
  outboxEvents,
  systemControls,
  withdrawals,
} from '../../database/schema/index.js';
import type { IdempotentExecutionResult } from '../idempotency/idempotency.types.js';
import { userIdempotencyScope } from '../idempotency/idempotency.util.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { InternalMetricsResponseDto } from './dto/internal-metrics-response.dto.js';
import type { ReceivableSettleResponseDto } from './dto/receivable-settle-response.dto.js';
import type { ReceivableSettleDto } from './dto/receivable-settle.dto.js';
import type { WithdrawalsPauseResponseDto } from './dto/withdrawals-pause-response.dto.js';
import type { WithdrawalsPauseDto } from './dto/withdrawals-pause.dto.js';

@Injectable()
export class InternalOpsService {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _databaseService: DatabaseService,
    private readonly _idempotencyService: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
  ) {}

  async settleReceivable(params: {
    idempotencyKey: string;
    requestHash?: string;
    dto: ReceivableSettleDto;
    operatorId: string;
  }): Promise<IdempotentExecutionResult<ReceivableSettleResponseDto>> {
    const { dto } = params;
    const otherCcy =
      dto.currency === Currency.IRT ? Currency.USDT : Currency.IRT;
    const availableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: UserAccountType.AVAILABLE,
    };
    const receivableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: UserAccountType.RECEIVABLE,
    };
    const otherReceivableSpec = {
      userId: dto.userId,
      currency: otherCcy,
      accountType: UserAccountType.RECEIVABLE,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec, receivableSpec, otherReceivableSpec],
      restrictionUserIds: [dto.userId],
    });

    return this._idempotencyService.executeInTransaction<ReceivableSettleResponseDto>(
      {
        scope: userIdempotencyScope(
          'POST:/internal/receivables/settle',
          dto.userId,
        ),
        key: params.idempotencyKey,
        requestBody: dto,
        requestHashOverride: params.requestHash,
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
          const otherReceivableRow =
            this._walletService.getRequiredLockedAccount(
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
            type: LedgerTxType.RECEIVABLE_SETTLE,
            referenceType: LedgerRefType.ADJUSTMENT,
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
                direction: LedgerDirection.DEBIT,
                amount: settleAmount,
              },
              {
                account: userReceivable,
                direction: LedgerDirection.CREDIT,
                amount: settleAmount,
              },
            ],
          });

          const remainingReceivable = receivable - settleAmount;
          const restrictionCleared =
            remainingReceivable === 0n &&
            (await this._walletService.clearReceivableRestriction(
              tx,
              dto.userId,
              dto.currency,
              otherReceivable === 0n,
            ));

          return {
            settlementId,
            userId: dto.userId,
            currency: dto.currency,
            settledAmount: formatMinorToApi(settleAmount, dto.currency),
            remainingReceivable: formatMinorToApi(
              remainingReceivable,
              dto.currency,
            ),
            outboundFrozen: frozen && !restrictionCleared,
          };
        },
      },
    );
  }

  async updateWithdrawalPause(params: {
    dto: WithdrawalsPauseDto;
    idempotencyKey: string;
    requestHash?: string;
  }): Promise<IdempotentExecutionResult<WithdrawalsPauseResponseDto>> {
    const { dto } = params;
    return this._idempotencyService.executeInTransaction({
      scope: 'POST:/internal/controls/withdrawals-pause',
      key: params.idempotencyKey,
      requestBody: dto,
      requestHashOverride: params.requestHash,
      statusCode: HttpStatus.OK,
      handler: (tx) => this.setPausedWithdrawals(dto, tx),
    });
  }

  async setPausedWithdrawals(
    dto: WithdrawalsPauseDto,
    db: DbExecutor = this._databaseService.db,
  ): Promise<WithdrawalsPauseResponseDto> {
    const currencies = [...new Set(dto.currencies)];
    const now = new Date();
    const [saved] = await db
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

    const refreshPromise = this._databaseService.pool
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
      this._databaseService.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(financialDiscrepancies)
        .where(eq(financialDiscrepancies.status, DiscrepancyStatus.OPEN)),
      this._databaseService.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(withdrawals)
        .where(eq(withdrawals.status, WithdrawalStatus.MANUAL_REVIEW)),
      this._databaseService.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(outboxEvents)
        .where(eq(outboxEvents.status, OutboxStatus.PENDING)),
      this._getCachedBalanceDriftAccounts(),
      this._databaseService.db
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

  formatPrometheusMetrics(metrics: InternalMetricsResponseDto): string {
    const irtPaused = metrics.pausedWithdrawalCurrencies.includes(Currency.IRT)
      ? 1
      : 0;
    const usdtPaused = metrics.pausedWithdrawalCurrencies.includes(
      Currency.USDT,
    )
      ? 1
      : 0;

    return [
      '# HELP t103_open_discrepancies Number of OPEN financial discrepancy rows',
      '# TYPE t103_open_discrepancies gauge',
      `t103_open_discrepancies ${metrics.openDiscrepancies}`,
      '# HELP t103_manual_review_withdrawals Number of withdrawals in MANUAL_REVIEW',
      '# TYPE t103_manual_review_withdrawals gauge',
      `t103_manual_review_withdrawals ${metrics.manualReviewWithdrawals}`,
      '# HELP t103_pending_outbox_events Number of PENDING transactional outbox events',
      '# TYPE t103_pending_outbox_events gauge',
      `t103_pending_outbox_events ${metrics.pendingOutboxEvents}`,
      '# HELP t103_balance_drift_accounts Number of USER accounts whose balance differs from ledger sum',
      '# TYPE t103_balance_drift_accounts gauge',
      `t103_balance_drift_accounts ${metrics.balanceDriftAccounts}`,
      '# HELP t103_withdrawals_paused Emergency withdrawal kill-switch state per currency (1=paused, 0=active)',
      '# TYPE t103_withdrawals_paused gauge',
      `t103_withdrawals_paused{currency="IRT"} ${irtPaused}`,
      `t103_withdrawals_paused{currency="USDT"} ${usdtPaused}`,
      '',
    ].join('\n');
  }

  private _getCachedBalanceDriftAccounts(): Promise<number> {
    const intervalMs = this._configService.get('DRIFT_AUDIT_INTERVAL_MS', {
      infer: true,
    });
    const workersEnabled = this._configService.get('WORKERS_ENABLED', {
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
