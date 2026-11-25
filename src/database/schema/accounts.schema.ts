import {
  boolean,
  date,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  accountOwnerTypeEnum,
  accountTypeEnum,
  currencyEnum,
  ledgerDirectionEnum,
} from './enums.js';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    ownerType: accountOwnerTypeEnum('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    currency: currencyEnum('currency').notNull(),
    accountType: accountTypeEnum('account_type').notNull(),
    normalSide: ledgerDirectionEnum('normal_side').notNull(),
    balance: numeric('balance', { precision: 38, scale: 0 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_owner_currency_type_uq').on(
      t.ownerType,
      t.ownerId,
      t.currency,
      t.accountType,
    ),
  ],
);

export const userDailyLimits = pgTable(
  'user_daily_limits',
  {
    userId: text('user_id').notNull(),
    limitDate: date('limit_date').notNull(),
    usedIrtAmount: numeric('used_irt_amount', { precision: 38, scale: 0 })
      .notNull()
      .default('0'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.limitDate] })],
);

export const userRestrictions = pgTable('user_restrictions', {
  userId: text('user_id').primaryKey(),
  outboundFrozen: boolean('outbound_frozen').notNull().default(false),
  freezeReason: text('freeze_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AccountEntity = typeof accounts.$inferSelect;
