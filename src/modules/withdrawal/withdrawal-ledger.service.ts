import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  Currency,
  DiscrepancyRefType,
  DiscrepancyStatus,
  DiscrepancyType,
  LedgerDirection,
  LedgerRefType,
  LedgerTxType,
  SystemOwnerId,
  UserAccountType,
  WithdrawalStatus,
} from '../../common/enums/domain.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { formatMinorToApi } from '../../common/utils/money.util.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.util.js';
import type { DbTransaction } from '../../database/database.types.js';
import {
  financialDiscrepancies,
  ledgerTransactions,
  userRestrictions,
  withdrawals,
} from '../../database/schema/index.js';
import type { LedgerPostingLine } from '../ledger/ledger.types.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type {
  WithdrawalEntity,
  WithdrawalPolicyAmounts,
} from './withdrawal.types.js';

@Injectable()
export class WithdrawalLedgerService {
  constructor(
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
  ) {}

  async createWithdrawalWithHold(
    tx: DbTransaction,
    params: {
      userId: string;
      currency: Currency;
      amountMinor: bigint;
      normalizedDest: string;
      limitDate: string;
      policy: WithdrawalPolicyAmounts;
      userAvailable: Awaited<
        ReturnType<WalletService['getRequiredLockedAccount']>
      >;
      userLocked: Awaited<
        ReturnType<WalletService['getRequiredLockedAccount']>
      >;
    },
  ): Promise<WithdrawalEntity> {
    const totalHold = params.amountMinor + params.policy.feeMinor;
    await this._walletService.addDailyLimitUsage(
      tx,
      params.userId,
      params.limitDate,
      params.policy.irtEquivalent,
    );

    const withdrawalId = generateUuidV7();
    const [inserted] = await tx
      .insert(withdrawals)
      .values({
        id: withdrawalId,
        userId: params.userId,
        currency: params.currency,
        amount: params.amountMinor.toString(),
        fee: params.policy.feeMinor.toString(),
        fxRateIrt: params.policy.fxRateIrt.toString(),
        irtEquivalent: params.policy.irtEquivalent.toString(),
        limitDate: params.limitDate,
        quotaReleased: false,
        destination: params.normalizedDest,
        providerRequestId: `wd_${withdrawalId}`,
        status: WithdrawalStatus.PENDING_DISPATCH,
        terminalReturn: false,
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
      type: LedgerTxType.WD_HOLD,
      referenceType: LedgerRefType.WITHDRAWAL,
      referenceId: withdrawalId,
      description: `Withdrawal hold for ${params.currency} payout`,
      metadata: {
        currency: params.currency,
        destination: params.normalizedDest,
        fee: formatMinorToApi(params.policy.feeMinor, params.currency),
      },
      postings: [
        {
          account: params.userAvailable,
          direction: LedgerDirection.DEBIT,
          amount: totalHold,
        },
        {
          account: params.userLocked,
          direction: LedgerDirection.CREDIT,
          amount: totalHold,
        },
      ],
    });

    return inserted;
  }

  async settleLockedWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    opts: {
      providerRefId: string | null;
      operatorId?: string;
      reason?: string;
    },
  ): Promise<WithdrawalEntity> {
    const ccy = locked.currency;
    const lockedSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.LOCKED,
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
      SystemOwnerId.PAYOUT_CLEARING,
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const postings: LedgerPostingLine[] = [
      {
        account: userLocked,
        direction: LedgerDirection.DEBIT,
        amount: amountMinor + feeMinor,
      },
      {
        account: payoutClearing,
        direction: LedgerDirection.CREDIT,
        amount: amountMinor,
      },
    ];

    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        SystemOwnerId.FEE_REVENUE,
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: LedgerDirection.CREDIT,
        amount: feeMinor,
      });
    }

    const resolvedRef = opts.providerRefId ?? locked.providerRefId;
    await this._ledgerService.postTransaction(tx, {
      type: LedgerTxType.WD_SETTLE,
      referenceType: LedgerRefType.WITHDRAWAL,
      referenceId: locked.id,
      description: opts.operatorId
        ? `Withdrawal resolved as SUCCEEDED by ${opts.operatorId} (${locked.providerRequestId})`
        : `Withdrawal settled via payout provider (${locked.providerRequestId})`,
      metadata: {
        providerRequestId: locked.providerRequestId,
        providerRefId: resolvedRef,
        ...(opts.operatorId ? { operatorId: opts.operatorId } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
      postings,
    });

    return this._finishWithdrawal(tx, locked, {
      status: WithdrawalStatus.SUCCEEDED,
      providerRefId: resolvedRef,
    });
  }

  async failAndReleaseLockedWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    opts: {
      reason: string;
      markTerminalReturn: boolean;
      operatorId?: string;
    },
  ): Promise<WithdrawalEntity> {
    const ccy = locked.currency;
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.AVAILABLE,
    };
    const lockedSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.LOCKED,
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
      type: LedgerTxType.WD_RELEASE,
      referenceType: LedgerRefType.WITHDRAWAL,
      referenceId: locked.id,
      description: `Release locked funds for failed/cancelled withdrawal (${opts.reason})`,
      metadata: {
        reason: opts.reason,
        markTerminalReturn: opts.markTerminalReturn,
        ...(opts.operatorId ? { operatorId: opts.operatorId } : {}),
      },
      postings: [
        {
          account: userLocked,
          direction: LedgerDirection.DEBIT,
          amount: totalHold,
        },
        {
          account: userAvailable,
          direction: LedgerDirection.CREDIT,
          amount: totalHold,
        },
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

    return this._finishWithdrawal(tx, locked, {
      status: WithdrawalStatus.FAILED,
      failureReason: opts.reason,
      terminalReturn: locked.terminalReturn || opts.markTerminalReturn,
      quotaReleased: true,
    });
  }

  async reverseSucceededWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    reason: string,
  ): Promise<WithdrawalEntity> {
    const ccy = locked.currency;
    const otherCcy = ccy === Currency.IRT ? Currency.USDT : Currency.IRT;
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.AVAILABLE,
    };
    const receivableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.RECEIVABLE,
    };
    const otherReceivableSpec = {
      userId: locked.userId,
      currency: otherCcy,
      accountType: UserAccountType.RECEIVABLE,
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
      SystemOwnerId.PAYOUT_CLEARING,
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
      {
        account: payoutClearing,
        direction: LedgerDirection.DEBIT,
        amount: amountMinor,
      },
    ];
    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        SystemOwnerId.FEE_REVENUE,
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: LedgerDirection.DEBIT,
        amount: feeMinor,
      });
    }
    if (receivableCredit > 0n) {
      postings.push({
        account: userReceivable,
        direction: LedgerDirection.CREDIT,
        amount: receivableCredit,
      });
    }
    if (availableCredit > 0n) {
      postings.push({
        account: userAvailable,
        direction: LedgerDirection.CREDIT,
        amount: availableCredit,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: LedgerTxType.WD_RETURN,
      referenceType: LedgerRefType.WITHDRAWAL,
      referenceId: locked.id,
      description: `Bank reversal / return for withdrawal (${reason})`,
      metadata: {
        reason,
        providerRefId: locked.providerRefId,
        receivableOffset: receivableCredit.toString(),
      },
      postings,
    });

    if (receivableCredit > 0n && currentReceivable === receivableCredit) {
      await this._walletService.clearReceivableRestriction(
        tx,
        locked.userId,
        ccy,
        BigInt(otherReceivable.balance ?? '0') === 0n,
      );
    }

    if (!locked.quotaReleased) {
      await this._walletService.addDailyLimitUsage(
        tx,
        locked.userId,
        locked.limitDate,
        -BigInt(locked.irtEquivalent),
      );
    }

    return this._finishWithdrawal(tx, locked, {
      status: WithdrawalStatus.FAILED,
      failureReason: reason,
      terminalReturn: true,
      quotaReleased: true,
    });
  }

  async markTerminalReturnOnly(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    reason: string,
  ): Promise<WithdrawalEntity> {
    if (locked.terminalReturn) {
      return locked;
    }
    return this._finishWithdrawal(tx, locked, {
      terminalReturn: true,
      failureReason: locked.failureReason ?? reason,
    });
  }

  async hasPriorSettlementOrReturn(
    tx: DbTransaction,
    withdrawalId: string,
  ): Promise<boolean> {
    const [existing] = await tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.referenceType, LedgerRefType.WITHDRAWAL),
          eq(ledgerTransactions.referenceId, withdrawalId),
          inArray(ledgerTransactions.type, [
            LedgerTxType.WD_SETTLE,
            LedgerTxType.WD_RETURN,
            LedgerTxType.WD_LATE_SUCCESS,
          ]),
        ),
      )
      .limit(1);
    return Boolean(existing);
  }

  async handleLateSuccessConflict(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    meta: { providerRefId: string | null; reason: string | null },
  ): Promise<WithdrawalEntity> {
    if (locked.lateSuccessConflict) {
      return locked;
    }

    const ccy = locked.currency;
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.AVAILABLE,
    };
    const receivableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountType.RECEIVABLE,
    };

    // Strict Canonical Lock Order: withdrawals (locked) -> user_daily_limits -> user_restrictions -> accounts ASC
    await this._walletService.lockDailyLimit(
      tx,
      locked.userId,
      locked.limitDate,
    );
    const frozen = await this._walletService.lockUserRestriction(
      tx,
      locked.userId,
    );
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
      SystemOwnerId.PAYOUT_CLEARING,
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
        direction: LedgerDirection.DEBIT,
        amount: clawback,
      });
    }
    if (shortfall > 0n) {
      postings.push({
        account: userReceivable,
        direction: LedgerDirection.DEBIT,
        amount: shortfall,
      });
    }
    postings.push({
      account: payoutClearing,
      direction: LedgerDirection.CREDIT,
      amount: amountMinor,
    });
    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        SystemOwnerId.FEE_REVENUE,
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: LedgerDirection.CREDIT,
        amount: feeMinor,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: LedgerTxType.WD_LATE_SUCCESS,
      referenceType: LedgerRefType.WITHDRAWAL,
      referenceId: locked.id,
      description: `Late payout success conflict recovery (${locked.providerRequestId})`,
      metadata: {
        providerRefId: meta.providerRefId,
        clawback: clawback.toString(),
        shortfall: shortfall.toString(),
      },
      postings,
    });

    if (locked.quotaReleased) {
      await this._walletService.addDailyLimitUsage(
        tx,
        locked.userId,
        locked.limitDate,
        BigInt(locked.irtEquivalent),
      );
    }

    const now = new Date();
    const updated = await this._finishWithdrawal(
      tx,
      locked,
      {
        status: WithdrawalStatus.SUCCEEDED,
        lateSuccessConflict: true,
        quotaReleased: false,
        providerRefId: meta.providerRefId ?? locked.providerRefId,
      },
      now,
    );

    if (shortfall > 0n && !frozen) {
      await tx
        .update(userRestrictions)
        .set({
          outboundFrozen: true,
          freezeReason: `AUTO-RECEIVABLE:${locked.id}`,
          updatedAt: now,
        })
        .where(eq(userRestrictions.userId, locked.userId));
    }

    await tx
      .insert(financialDiscrepancies)
      .values({
        id: generateUuidV7(),
        referenceType: DiscrepancyRefType.WITHDRAWAL,
        referenceId: locked.id,
        userId: locked.userId,
        discrepancyType: DiscrepancyType.LATE_SUCCESS_CONFLICT,
        amount: totalOutflow.toString(),
        currency: ccy,
        providerPayload: {
          providerRequestId: locked.providerRequestId,
          providerRefId: meta.providerRefId,
          clawback: clawback.toString(),
          shortfall: shortfall.toString(),
        },
        status:
          shortfall > 0n ? DiscrepancyStatus.OPEN : DiscrepancyStatus.RESOLVED,
      })
      .onConflictDoNothing({
        target: [
          financialDiscrepancies.referenceType,
          financialDiscrepancies.referenceId,
          financialDiscrepancies.discrepancyType,
        ],
      });

    return updated;
  }

  private async _finishWithdrawal(
    tx: DbTransaction,
    locked: WithdrawalEntity,
    changes: Partial<
      Pick<
        WithdrawalEntity,
        | 'status'
        | 'failureReason'
        | 'providerRefId'
        | 'terminalReturn'
        | 'quotaReleased'
        | 'lateSuccessConflict'
      >
    >,
    updatedAt = new Date(),
  ): Promise<WithdrawalEntity> {
    const [updated] = await tx
      .update(withdrawals)
      .set({
        ...changes,
        leaseUntil: null,
        nextPollAt: null,
        version: sql`${withdrawals.version} + 1`,
        updatedAt,
      })
      .where(eq(withdrawals.id, locked.id))
      .returning();
    return updated ?? locked;
  }
}
