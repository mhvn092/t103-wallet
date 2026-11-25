import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, like, lt, or, sql } from 'drizzle-orm';
import {
  AccountOwnerTypeEnum,
  AccountTypeEnum,
  WalletAccountFilterEnum,
} from '../../common/enums/account.enums.js';
import {
  DiscrepancyStatusEnum,
  DiscrepancyTypeEnum,
} from '../../common/enums/discrepancy.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../common/enums/currency.enum.js';
import { formatMinorToApi } from '../../common/utils/money.util.js';
import { v7 as generateUuidV7 } from 'uuid';
import { DatabaseService } from '../../database/database.service.js';
import type {
  DbExecutor,
  DbTransaction,
} from '../../database/database.types.js';
import {
  type AccountEntity,
  accounts,
  userDailyLimits,
  userRestrictions,
} from '../../database/schema/accounts.schema.js';
import { financialDiscrepancies } from '../../database/schema/operations.schema.js';
import {
  ledgerItems,
  ledgerTransactions,
} from '../../database/schema/ledger.schema.js';
import { WalletBalancesResponseDto } from './dto/wallet-balance-response.dto.js';
import { WalletLedgerResponseDto } from './dto/wallet-ledger-response.dto.js';
import type {
  AccountSpecInterface,
  WalletBalanceViewInterface,
} from './wallet.interface.js';
import {
  USER_ACCOUNT_NORMAL_SIDE,
  USER_TO_ACCOUNT_TYPE,
} from './wallet.constants.js';
import {
  UserAccountTypeEnum,
  type SystemOwnerIdEnum,
} from '../../common/enums/account.enums.js';

@Injectable()
export class WalletService {
  constructor(private readonly _databaseService: DatabaseService) {}

  /**
   * Check-first then sorted autocommit scaffold creation outside TX1 so 0-balance shell rows
   * never cause unique-index XID deadlocks or rollback tuple bloat under concurrency.
   */
  async ensureUserScaffold(params: {
    accountSpecs: AccountSpecInterface[];
    dailyLimitKeys?: Array<{ userId: string; limitDate: string }>;
    restrictionUserIds?: string[];
  }): Promise<void> {
    const dedupedSpecs = this._sortAccountSpecs(params.accountSpecs);
    if (dedupedSpecs.length > 0) {
      await this._ensureMissingAccounts(dedupedSpecs);
    }

    if (params.dailyLimitKeys && params.dailyLimitKeys.length > 0) {
      const sortedLimits = [...params.dailyLimitKeys].sort(
        (a, b) =>
          a.userId.localeCompare(b.userId) ||
          a.limitDate.localeCompare(b.limitDate),
      );
      await this._databaseService.db
        .insert(userDailyLimits)
        .values(
          sortedLimits.map((k) => ({
            userId: k.userId,
            limitDate: k.limitDate,
            usedIrtAmount: '0',
          })),
        )
        .onConflictDoNothing();
    }

    if (params.restrictionUserIds && params.restrictionUserIds.length > 0) {
      const sortedUsers = [...new Set(params.restrictionUserIds)].sort();
      await this._databaseService.db
        .insert(userRestrictions)
        .values(
          sortedUsers.map((userId) => ({
            userId,
            outboundFrozen: false,
          })),
        )
        .onConflictDoNothing();
    }
  }

  /**
   * Acquires row-level FOR UPDATE locks on USER accounts strictly ordered by accounts.id ASC.
   */
  async lockUserAccountsCanonical(
    tx: DbTransaction,
    specs: AccountSpecInterface[],
  ): Promise<AccountEntity[]> {
    const sortedSpecs = this._sortAccountSpecs(specs);
    if (!sortedSpecs.length) {
      return [];
    }

    const rows = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, AccountOwnerTypeEnum.USER),
          or(
            ...sortedSpecs.map((spec) =>
              and(
                eq(accounts.ownerId, spec.userId),
                eq(accounts.currency, spec.currency),
                eq(
                  accounts.accountType,
                  USER_TO_ACCOUNT_TYPE[spec.accountType],
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(accounts.id))
      .for('update');

    for (const spec of sortedSpecs) {
      this.getRequiredLockedAccount(rows, spec);
    }
    return rows;
  }

  getRequiredLockedAccount(
    lockedAccounts: readonly AccountEntity[],
    spec: AccountSpecInterface,
  ): AccountEntity {
    const row = lockedAccounts.find((account) =>
      this._matchesAccountSpec(account, spec),
    );
    if (!row) {
      throw new DomainException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        `Missing scaffolded USER account for ${spec.userId} (${spec.currency} ${spec.accountType})`,
      );
    }
    return row;
  }

  /**
   * Reads a seeded SYSTEM account without locking it.
   */
  async getSystemAccount(
    executor: DbExecutor,
    ownerId: SystemOwnerIdEnum,
    currency: CurrencyEnum,
  ): Promise<AccountEntity> {
    const [row] = await executor
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, AccountOwnerTypeEnum.SYSTEM),
          eq(accounts.ownerId, ownerId),
          eq(accounts.currency, currency),
        ),
      )
      .limit(1);

    if (!row) {
      throw new DomainException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        `Seeded SYSTEM account missing: ${ownerId}:${currency}`,
      );
    }
    return row;
  }

  async getWalletBalances(userId: string): Promise<WalletBalancesResponseDto> {
    const rows = await this._databaseService.db
      .select({
        currency: accounts.currency,
        accountType: accounts.accountType,
        balance: accounts.balance,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, AccountOwnerTypeEnum.USER),
          eq(accounts.ownerId, userId),
        ),
      );

    const byKey = new Map<string, bigint>();
    for (const row of rows) {
      byKey.set(
        `${row.currency}|${row.accountType}`,
        row.balance !== null ? BigInt(row.balance) : 0n,
      );
    }

    const balances: WalletBalanceViewInterface[] = CURRENCIES.map(
      (currency) => ({
        currency,
        available: formatMinorToApi(
          byKey.get(`${currency}|${AccountTypeEnum.AVAILABLE}`) ?? 0n,
          currency,
        ),
        locked: formatMinorToApi(
          byKey.get(`${currency}|${AccountTypeEnum.LOCKED}`) ?? 0n,
          currency,
        ),
        receivable: formatMinorToApi(
          byKey.get(`${currency}|${AccountTypeEnum.RECEIVABLE}`) ?? 0n,
          currency,
        ),
      }),
    );

    return { userId, balances };
  }

  async getUserLedger(params: {
    userId: string;
    limit: number;
    cursor?: bigint;
    accountType?: WalletAccountFilterEnum;
    currency?: CurrencyEnum;
  }): Promise<WalletLedgerResponseDto> {
    const accountFilter = params.accountType ?? WalletAccountFilterEnum.ALL;
    const conditions = [eq(ledgerItems.userId, params.userId)];

    if (accountFilter !== WalletAccountFilterEnum.ALL) {
      conditions.push(
        eq(
          ledgerItems.accountType,
          USER_TO_ACCOUNT_TYPE[accountFilter as unknown as UserAccountTypeEnum],
        ),
      );
    }
    if (params.currency) {
      conditions.push(eq(ledgerItems.currency, params.currency));
    }
    if (params.cursor !== undefined) {
      conditions.push(lt(ledgerItems.id, params.cursor));
    }

    const rows = await this._databaseService.db
      .select({
        id: ledgerItems.id,
        transactionId: ledgerItems.transactionId,
        type: ledgerTransactions.type,
        referenceType: ledgerTransactions.referenceType,
        referenceId: ledgerTransactions.referenceId,
        currency: ledgerItems.currency,
        accountType: ledgerItems.accountType,
        direction: ledgerItems.direction,
        amount: ledgerItems.amount,
        balanceAfter: ledgerItems.balanceAfter,
        description: ledgerTransactions.description,
        createdAt: ledgerItems.createdAt,
      })
      .from(ledgerItems)
      .innerJoin(
        ledgerTransactions,
        eq(ledgerItems.transactionId, ledgerTransactions.id),
      )
      .where(and(...conditions))
      .orderBy(desc(ledgerItems.id))
      .limit(params.limit + 1);

    const hasMore = rows.length > params.limit;
    const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
    const lastItem = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map((row) => ({
        id: row.id.toString(),
        transactionId: row.transactionId,
        type: row.type,
        currency: row.currency,
        accountType: row.accountType,
        direction: row.direction,
        amount: formatMinorToApi(BigInt(row.amount), row.currency),
        balanceAfter:
          row.balanceAfter !== null
            ? formatMinorToApi(BigInt(row.balanceAfter), row.currency)
            : null,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore && lastItem ? lastItem.id.toString() : null,
    };
  }

  async lockUserRestriction(
    tx: DbTransaction,
    userId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ outboundFrozen: userRestrictions.outboundFrozen })
      .from(userRestrictions)
      .where(eq(userRestrictions.userId, userId))
      .for('update')
      .limit(1);

    return row?.outboundFrozen ?? false;
  }

  async clearReceivableRestriction(
    tx: DbTransaction,
    userId: string,
    currency: CurrencyEnum,
    allCleared: boolean,
  ): Promise<boolean> {
    await tx
      .update(financialDiscrepancies)
      .set({ status: DiscrepancyStatusEnum.RESOLVED })
      .where(
        and(
          eq(financialDiscrepancies.userId, userId),
          eq(financialDiscrepancies.currency, currency),
          eq(
            financialDiscrepancies.discrepancyType,
            DiscrepancyTypeEnum.LATE_SUCCESS_CONFLICT,
          ),
          eq(financialDiscrepancies.status, DiscrepancyStatusEnum.OPEN),
        ),
      );

    if (!allCleared) {
      return false;
    }

    const [cleared] = await tx
      .update(userRestrictions)
      .set({ outboundFrozen: false, freezeReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(userRestrictions.userId, userId),
          like(userRestrictions.freezeReason, 'AUTO-RECEIVABLE:%'),
        ),
      )
      .returning({ userId: userRestrictions.userId });
    return Boolean(cleared);
  }

  async lockDailyLimit(
    tx: DbTransaction,
    userId: string,
    limitDate: string,
  ): Promise<bigint> {
    const [row] = await tx
      .select({ usedIrtAmount: userDailyLimits.usedIrtAmount })
      .from(userDailyLimits)
      .where(
        and(
          eq(userDailyLimits.userId, userId),
          eq(userDailyLimits.limitDate, limitDate),
        ),
      )
      .for('update')
      .limit(1);
    return row ? BigInt(row.usedIrtAmount) : 0n;
  }

  async addDailyLimitUsage(
    tx: DbTransaction,
    userId: string,
    limitDate: string,
    deltaIrt: bigint,
  ): Promise<void> {
    await tx
      .update(userDailyLimits)
      .set({
        usedIrtAmount: sql`${userDailyLimits.usedIrtAmount} + ${deltaIrt.toString()}`,
      })
      .where(
        and(
          eq(userDailyLimits.userId, userId),
          eq(userDailyLimits.limitDate, limitDate),
        ),
      );
  }

  private async _ensureMissingAccounts(
    dedupedSpecs: AccountSpecInterface[],
  ): Promise<void> {
    const userIds = [...new Set(dedupedSpecs.map((s) => s.userId))];
    const existing = await this._databaseService.db
      .select({
        ownerId: accounts.ownerId,
        currency: accounts.currency,
        accountType: accounts.accountType,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, AccountOwnerTypeEnum.USER),
          inArray(accounts.ownerId, userIds),
        ),
      );

    const missing = dedupedSpecs.filter(
      (spec) => !existing.some((row) => this._matchesAccountSpec(row, spec)),
    );

    if (missing.length > 0) {
      await this._databaseService.db
        .insert(accounts)
        .values(
          missing.map((spec) => ({
            id: generateUuidV7(),
            ownerType: AccountOwnerTypeEnum.USER,
            ownerId: spec.userId,
            currency: spec.currency,
            accountType: USER_TO_ACCOUNT_TYPE[spec.accountType],
            normalSide: USER_ACCOUNT_NORMAL_SIDE[spec.accountType],
            balance: '0',
          })),
        )
        .onConflictDoNothing();
    }
  }

  private _sortAccountSpecs(
    specs: AccountSpecInterface[],
  ): AccountSpecInterface[] {
    const unique: AccountSpecInterface[] = [];
    for (const spec of specs) {
      if (
        !unique.some(
          (item) =>
            item.userId === spec.userId &&
            item.currency === spec.currency &&
            item.accountType === spec.accountType,
        )
      ) {
        unique.push(spec);
      }
    }
    return unique.sort(
      (a, b) =>
        a.userId.localeCompare(b.userId) ||
        a.currency.localeCompare(b.currency) ||
        a.accountType.localeCompare(b.accountType),
    );
  }

  private _matchesAccountSpec(
    row: Pick<AccountEntity, 'ownerId' | 'currency' | 'accountType'>,
    spec: AccountSpecInterface,
  ): boolean {
    return (
      row.ownerId === spec.userId &&
      row.currency === spec.currency &&
      row.accountType === USER_TO_ACCOUNT_TYPE[spec.accountType]
    );
  }
}
