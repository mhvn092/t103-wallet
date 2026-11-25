import type { WithdrawalPolicyAmountsInterface } from './withdrawal.interface.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import {
  DiscrepancyRefTypeEnum,
  DiscrepancyStatusEnum,
  DiscrepancyTypeEnum,
} from '../../common/enums/discrepancy.enums.js';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../common/enums/ledger.enums.js';
import {
  SystemOwnerIdEnum,
  UserAccountTypeEnum,
} from '../../common/enums/account.enums.js';
import { WithdrawalStatusEnum } from '../../common/enums/withdrawal.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { formatMinorToApi } from '../../common/utils/money.util.js';
import { v7 as generateUuidV7 } from 'uuid';
import type { DbTransaction } from '../../database/database.types.js';
import {
  financialDiscrepancies,
  withdrawals,
} from '../../database/schema/operations.schema.js';
import { ledgerTransactions } from '../../database/schema/ledger.schema.js';
import { userRestrictions } from '../../database/schema/accounts.schema.js';
import type { LedgerPostingLineInterface } from '../ledger/ledger.interface.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { WithdrawalEntity } from './withdrawal.types.js';

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
      currency: CurrencyEnum;
      amountMinor: bigint;
      normalizedDest: string;
      limitDate: string;
      policy: WithdrawalPolicyAmountsInterface;
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
        status: WithdrawalStatusEnum.PENDING_DISPATCH,
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
      type: LedgerTxTypeEnum.WD_HOLD,
      referenceType: LedgerRefTypeEnum.WITHDRAWAL,
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
          direction: LedgerDirectionEnum.DEBIT,
          amount: totalHold,
        },
        {
          account: params.userLocked,
          direction: LedgerDirectionEnum.CREDIT,
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
      accountType: UserAccountTypeEnum.LOCKED,
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
      SystemOwnerIdEnum.PAYOUT_CLEARING,
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const postings: LedgerPostingLineInterface[] = [
      {
        account: userLocked,
        direction: LedgerDirectionEnum.DEBIT,
        amount: amountMinor + feeMinor,
      },
      {
        account: payoutClearing,
        direction: LedgerDirectionEnum.CREDIT,
        amount: amountMinor,
      },
    ];

    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        SystemOwnerIdEnum.FEE_REVENUE,
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: LedgerDirectionEnum.CREDIT,
        amount: feeMinor,
      });
    }

    const resolvedRef = opts.providerRefId ?? locked.providerRefId;
    await this._ledgerService.postTransaction(tx, {
      type: LedgerTxTypeEnum.WD_SETTLE,
      referenceType: LedgerRefTypeEnum.WITHDRAWAL,
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
      status: WithdrawalStatusEnum.SUCCEEDED,
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
      accountType: UserAccountTypeEnum.AVAILABLE,
    };
    const lockedSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountTypeEnum.LOCKED,
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
      type: LedgerTxTypeEnum.WD_RELEASE,
      referenceType: LedgerRefTypeEnum.WITHDRAWAL,
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
          direction: LedgerDirectionEnum.DEBIT,
          amount: totalHold,
        },
        {
          account: userAvailable,
          direction: LedgerDirectionEnum.CREDIT,
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
      status: WithdrawalStatusEnum.FAILED,
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
    const otherCcy =
      ccy === CurrencyEnum.IRT ? CurrencyEnum.USDT : CurrencyEnum.IRT;
    const availableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountTypeEnum.AVAILABLE,
    };
    const receivableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountTypeEnum.RECEIVABLE,
    };
    const otherReceivableSpec = {
      userId: locked.userId,
      currency: otherCcy,
      accountType: UserAccountTypeEnum.RECEIVABLE,
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
      SystemOwnerIdEnum.PAYOUT_CLEARING,
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const totalRefund = amountMinor + feeMinor;
    const currentReceivable = BigInt(userReceivable.balance ?? '0');
    const receivableCredit =
      currentReceivable >= totalRefund ? totalRefund : currentReceivable;
    const availableCredit = totalRefund - receivableCredit;

    const postings: LedgerPostingLineInterface[] = [
      {
        account: payoutClearing,
        direction: LedgerDirectionEnum.DEBIT,
        amount: amountMinor,
      },
    ];
    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        SystemOwnerIdEnum.FEE_REVENUE,
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: LedgerDirectionEnum.DEBIT,
        amount: feeMinor,
      });
    }
    if (receivableCredit > 0n) {
      postings.push({
        account: userReceivable,
        direction: LedgerDirectionEnum.CREDIT,
        amount: receivableCredit,
      });
    }
    if (availableCredit > 0n) {
      postings.push({
        account: userAvailable,
        direction: LedgerDirectionEnum.CREDIT,
        amount: availableCredit,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: LedgerTxTypeEnum.WD_RETURN,
      referenceType: LedgerRefTypeEnum.WITHDRAWAL,
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
      status: WithdrawalStatusEnum.FAILED,
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
          eq(ledgerTransactions.referenceType, LedgerRefTypeEnum.WITHDRAWAL),
          eq(ledgerTransactions.referenceId, withdrawalId),
          inArray(ledgerTransactions.type, [
            LedgerTxTypeEnum.WD_SETTLE,
            LedgerTxTypeEnum.WD_RETURN,
            LedgerTxTypeEnum.WD_LATE_SUCCESS,
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
      accountType: UserAccountTypeEnum.AVAILABLE,
    };
    const receivableSpec = {
      userId: locked.userId,
      currency: ccy,
      accountType: UserAccountTypeEnum.RECEIVABLE,
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
      SystemOwnerIdEnum.PAYOUT_CLEARING,
      ccy,
    );

    const amountMinor = BigInt(locked.amount);
    const feeMinor = BigInt(locked.fee);
    const totalOutflow = amountMinor + feeMinor;
    const currentAvailable = BigInt(userAvailable.balance ?? '0');
    const clawback =
      currentAvailable >= totalOutflow ? totalOutflow : currentAvailable;
    const shortfall = totalOutflow - clawback;

    const postings: LedgerPostingLineInterface[] = [];
    if (clawback > 0n) {
      postings.push({
        account: userAvailable,
        direction: LedgerDirectionEnum.DEBIT,
        amount: clawback,
      });
    }
    if (shortfall > 0n) {
      postings.push({
        account: userReceivable,
        direction: LedgerDirectionEnum.DEBIT,
        amount: shortfall,
      });
    }
    postings.push({
      account: payoutClearing,
      direction: LedgerDirectionEnum.CREDIT,
      amount: amountMinor,
    });
    if (feeMinor > 0n) {
      const feeRevenue = await this._walletService.getSystemAccount(
        tx,
        SystemOwnerIdEnum.FEE_REVENUE,
        ccy,
      );
      postings.push({
        account: feeRevenue,
        direction: LedgerDirectionEnum.CREDIT,
        amount: feeMinor,
      });
    }

    await this._ledgerService.postTransaction(tx, {
      type: LedgerTxTypeEnum.WD_LATE_SUCCESS,
      referenceType: LedgerRefTypeEnum.WITHDRAWAL,
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
        status: WithdrawalStatusEnum.SUCCEEDED,
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
        referenceType: DiscrepancyRefTypeEnum.WITHDRAWAL,
        referenceId: locked.id,
        userId: locked.userId,
        discrepancyType: DiscrepancyTypeEnum.LATE_SUCCESS_CONFLICT,
        amount: totalOutflow.toString(),
        currency: ccy,
        providerPayload: {
          providerRequestId: locked.providerRequestId,
          providerRefId: meta.providerRefId,
          clawback: clawback.toString(),
          shortfall: shortfall.toString(),
        },
        status:
          shortfall > 0n
            ? DiscrepancyStatusEnum.OPEN
            : DiscrepancyStatusEnum.RESOLVED,
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
