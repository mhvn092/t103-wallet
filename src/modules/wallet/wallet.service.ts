import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  CURRENCIES,
  type Currency,
  formatMinorToApi,
} from '../../common/utils/money.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.js';
import { DatabaseService } from '../../database/database.service.js';
import type {
  DbExecutor,
  DbTransaction,
} from '../../database/database.types.js';
import {
  type AccountRow,
  accounts,
  ledgerItems,
  ledgerTransactions,
  userDailyLimits,
  userRestrictions,
} from '../../database/schema/index.js';
import { WalletBalancesResponseDto } from './dto/wallet-balance-response.dto.js';
import { WalletLedgerResponseDto } from './dto/wallet-ledger-response.dto.js';
import {
  type AccountSpec,
  type SystemOwnerId,
  USER_ACCOUNT_NORMAL_SIDE,
  type UserAccountType,
  type WalletBalanceView,
} from './wallet.types.js';

@Injectable()
export class WalletService {
  constructor(private readonly _database: DatabaseService) {}

  /**
   * Check-first then sorted autocommit scaffold creation outside TX1 so 0-balance shell rows
   * never cause unique-index XID deadlocks or rollback tuple bloat under concurrency.
   */
  async ensureUserScaffold(params: {
    accountSpecs: AccountSpec[];
    dailyLimitKeys?: Array<{ userId: string; limitDate: string }>;
    restrictionUserIds?: string[];
  }): Promise<void> {
    const dedupedSpecs = this._sortAccountSpecs(params.accountSpecs);
    if (dedupedSpecs.length > 0) {
      await this._ensureMissingAccounts(dedupedSpecs);
    }

    if (params.dailyLimitKeys && params.dailyLimitKeys.length > 0) {
      const sortedLimits = [...params.dailyLimitKeys].sort((a, b) =>
        `${a.userId}|${a.limitDate}`.localeCompare(
          `${b.userId}|${b.limitDate}`,
        ),
      );
      await this._database.db
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
      await this._database.db
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
    specs: AccountSpec[],
  ): Promise<Map<string, AccountRow>> {
    const sortedSpecs = this._sortAccountSpecs(specs);
    const userIds = [...new Set(sortedSpecs.map((s) => s.userId))];
    const currencies = [...new Set(sortedSpecs.map((s) => s.currency))];
    const accountTypes = [...new Set(sortedSpecs.map((s) => s.accountType))];

    const rows = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, 'USER'),
          inArray(accounts.ownerId, userIds),
          inArray(accounts.currency, currencies),
          inArray(accounts.accountType, accountTypes),
        ),
      )
      .orderBy(asc(accounts.id))
      .for('update');

    const map = new Map<string, AccountRow>();
    for (const row of rows) {
      map.set(`${row.ownerId}|${row.currency}|${row.accountType}`, row);
    }

    for (const spec of sortedSpecs) {
      this.getRequiredLockedAccount(map, spec);
    }
    return map;
  }

  getRequiredLockedAccount(
    map: ReadonlyMap<string, AccountRow>,
    spec: AccountSpec,
  ): AccountRow {
    const key = `${spec.userId}|${spec.currency}|${spec.accountType}`;
    const row = map.get(key);
    if (!row) {
      throw new DomainException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        `Missing scaffolded USER account for ${key}`,
      );
    }
    return row;
  }

  /**
   * Reads a seeded SYSTEM account without locking it.
   */
  async getSystemAccount(
    executor: DbExecutor,
    ownerId: SystemOwnerId,
    currency: Currency,
  ): Promise<AccountRow> {
    const [row] = await executor
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, 'SYSTEM'),
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
    const rows = await this._database.db
      .select({
        currency: accounts.currency,
        accountType: accounts.accountType,
        balance: accounts.balance,
      })
      .from(accounts)
      .where(and(eq(accounts.ownerType, 'USER'), eq(accounts.ownerId, userId)));

    const byKey = new Map<string, bigint>();
    for (const row of rows) {
      byKey.set(
        `${row.currency}|${row.accountType}`,
        row.balance !== null ? BigInt(row.balance) : 0n,
      );
    }

    const balances: WalletBalanceView[] = CURRENCIES.map((currency) => ({
      currency,
      available: formatMinorToApi(
        byKey.get(`${currency}|AVAILABLE`) ?? 0n,
        currency,
      ),
      locked: formatMinorToApi(byKey.get(`${currency}|LOCKED`) ?? 0n, currency),
      receivable: formatMinorToApi(
        byKey.get(`${currency}|RECEIVABLE`) ?? 0n,
        currency,
      ),
    }));

    return { userId, balances };
  }

  async getUserLedger(params: {
    userId: string;
    limit: number;
    cursor?: bigint;
    accountType?: UserAccountType | 'ALL';
    currency?: Currency;
  }): Promise<WalletLedgerResponseDto> {
    const accountFilter = params.accountType ?? 'AVAILABLE';
    const conditions = [eq(ledgerItems.userId, params.userId)];

    if (accountFilter !== 'ALL') {
      conditions.push(eq(ledgerItems.accountType, accountFilter));
    }
    if (params.currency) {
      conditions.push(eq(ledgerItems.currency, params.currency));
    }
    if (params.cursor !== undefined) {
      conditions.push(lt(ledgerItems.id, params.cursor));
    }

    const rows = await this._database.db
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
      items: pageRows.map((row) => {
        const ccy: Currency = row.currency === 'USDT' ? 'USDT' : 'IRT';
        return {
          id: row.id.toString(),
          transactionId: row.transactionId,
          type: row.type,
          currency: ccy,
          accountType: row.accountType,
          direction: row.direction,
          amount: formatMinorToApi(BigInt(row.amount), ccy),
          balanceAfter:
            row.balanceAfter !== null
              ? formatMinorToApi(BigInt(row.balanceAfter), ccy)
              : null,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          description: row.description,
          createdAt: row.createdAt.toISOString(),
        };
      }),
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
    dedupedSpecs: AccountSpec[],
  ): Promise<void> {
    const userIds = [...new Set(dedupedSpecs.map((s) => s.userId))];
    const existing = await this._database.db
      .select({
        ownerId: accounts.ownerId,
        currency: accounts.currency,
        accountType: accounts.accountType,
      })
      .from(accounts)
      .where(
        and(eq(accounts.ownerType, 'USER'), inArray(accounts.ownerId, userIds)),
      );

    const existingKeys = new Set(
      existing.map((r) => `${r.ownerId}|${r.currency}|${r.accountType}`),
    );
    const missing = dedupedSpecs.filter(
      (s) => !existingKeys.has(`${s.userId}|${s.currency}|${s.accountType}`),
    );

    if (missing.length > 0) {
      await this._database.db
        .insert(accounts)
        .values(
          missing.map((spec) => ({
            id: generateUuidV7(),
            ownerType: 'USER',
            ownerId: spec.userId,
            currency: spec.currency,
            accountType: spec.accountType,
            normalSide: USER_ACCOUNT_NORMAL_SIDE[spec.accountType],
            balance: '0',
          })),
        )
        .onConflictDoNothing();
    }
  }

  private _sortAccountSpecs(specs: AccountSpec[]): AccountSpec[] {
    const unique = new Map<string, AccountSpec>();
    for (const spec of specs) {
      unique.set(`${spec.userId}|${spec.currency}|${spec.accountType}`, spec);
    }
    return [...unique.values()].sort((a, b) =>
      `${a.userId}|${a.currency}|${a.accountType}`.localeCompare(
        `${b.userId}|${b.currency}|${b.accountType}`,
      ),
    );
  }
}
