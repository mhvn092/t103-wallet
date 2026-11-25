import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.schema.js';
import {
  accountTypeEnum,
  currencyEnum,
  ledgerDirectionEnum,
  ledgerRefTypeEnum,
  ledgerTxTypeEnum,
} from './pg-enums.schema.js';

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    type: ledgerTxTypeEnum('type').notNull(),
    referenceType: ledgerRefTypeEnum('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    description: text('description').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_tx_ref_type_uq').on(
      t.referenceType,
      t.referenceId,
      t.type,
    ),
  ],
);

export const ledgerItems = pgTable(
  'ledger_items',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: text('user_id'),
    accountType: accountTypeEnum('account_type').notNull(),
    currency: currencyEnum('currency').notNull(),
    direction: ledgerDirectionEnum('direction').notNull(),
    amount: numeric('amount', { precision: 38, scale: 0 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 38, scale: 0 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ledger_items_tx_idx').on(t.transactionId),
    index('ledger_items_user_cursor_idx')
      .on(t.userId, t.id.desc())
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);
