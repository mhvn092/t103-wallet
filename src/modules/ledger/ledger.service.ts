import { Injectable } from '@nestjs/common';
import { type Currency, formatMinorToApi } from '../../common/utils/money.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.js';
import type { DbTransaction } from '../../database/database.types.js';
import {
  ledgerItems,
  ledgerTransactions,
  outboxEvents,
} from '../../database/schema/index.js';
import type {
  PostLedgerTxInput,
  PostLedgerTxResult,
} from './ledger.types.js';

@Injectable()
export class LedgerService {
  /**
   * Inserts an immutable double-entry ledger transaction and its posting lines.
   * PostgreSQL's BEFORE INSERT trigger on ledger_items projects USER account balances
   * and populates balance_after; the DEFERRABLE constraint trigger on ledger_transactions
   * enforces per-currency SUM(DEBIT) == SUM(CREDIT) at COMMIT.
   *
   * Also emits a transactional BALANCE_CHANGED outbox event in the same TX whenever any
   * USER account is touched.
   */
  async postTransaction(
    tx: DbTransaction,
    input: PostLedgerTxInput,
  ): Promise<PostLedgerTxResult> {
    if (input.postings.length < 2) {
      throw new Error('Ledger transaction requires at least 2 posting lines');
    }

    const totals = new Map<Currency, { debit: bigint; credit: bigint }>();
    for (const line of input.postings) {
      if (line.amount <= 0n) {
        throw new Error('Ledger posting amount must be positive');
      }
      const ccy = line.account.currency as Currency;
      const accTotals = totals.get(ccy) ?? { debit: 0n, credit: 0n };
      if (line.direction === 'DEBIT') {
        accTotals.debit += line.amount;
      } else {
        accTotals.credit += line.amount;
      }
      totals.set(ccy, accTotals);
    }

    for (const [ccy, sum] of totals.entries()) {
      if (sum.debit !== sum.credit || sum.debit <= 0n) {
        throw new Error(
          `Unbalanced postings for ${ccy}: debit=${sum.debit} credit=${sum.credit}`,
        );
      }
    }

    const txId = generateUuidV7();
    await tx.insert(ledgerTransactions).values({
      id: txId,
      type: input.type,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      metadata: input.metadata ?? {},
    });

    const insertedItems = await tx
      .insert(ledgerItems)
      .values(
        input.postings.map((line) => ({
          transactionId: txId,
          accountId: line.account.id,
          userId:
            line.account.ownerType === 'USER' ? line.account.ownerId : null,
          accountType: line.account.accountType,
          currency: line.account.currency,
          direction: line.direction,
          amount: line.amount.toString(),
          balanceAfter: null, // Populated by Postgres trg_ledger_item_project_balance for USER rows
        })),
      )
      .returning();

    const userChanges = insertedItems
      .filter((item) => item.userId !== null)
      .map((item) => {
        const ccy = item.currency as Currency;
        return {
          userId: item.userId!,
          currency: ccy,
          accountType: item.accountType,
          direction: item.direction,
          amount: formatMinorToApi(BigInt(item.amount), ccy),
          balanceAfter:
            item.balanceAfter !== null
              ? formatMinorToApi(BigInt(item.balanceAfter), ccy)
              : null,
        };
      });

    if (userChanges.length > 0) {
      await tx.insert(outboxEvents).values({
        id: generateUuidV7(),
        eventType: 'BALANCE_CHANGED',
        payload: {
          transactionId: txId,
          transactionType: input.type,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          changes: userChanges,
          occurredAt: new Date().toISOString(),
        },
        status: 'PENDING',
      });
    }

    return {
      transactionId: txId,
      items: insertedItems.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        userId: row.userId,
        currency: row.currency as Currency,
        accountType: row.accountType,
        direction: row.direction as 'DEBIT' | 'CREDIT',
        amount: BigInt(row.amount),
        balanceAfter:
          row.balanceAfter !== null ? BigInt(row.balanceAfter) : null,
      })),
    };
  }
}
