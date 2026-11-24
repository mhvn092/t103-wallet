import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

function auditTimestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(), // 'IN_PROGRESS' | 'COMPLETED'
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<unknown>(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    leaseVersion: bigint('lease_version', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.key] }),
    index('idempotency_expires_idx').on(t.expiresAt),
  ],
);

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    requestedAmount: numeric('requested_amount', {
      precision: 38,
      scale: 0,
    }).notNull(),
    verifiedAmount: numeric('verified_amount', { precision: 38, scale: 0 }),
    amountMismatch: boolean('amount_mismatch').notNull().default(false),
    orderId: text('order_id').notNull().unique(),
    pspToken: text('psp_token').unique(),
    pspRefId: text('psp_ref_id'),
    paymentUrl: text('payment_url'),
    status: text('status').notNull(), // 'INITIATED' | 'AWAITING_PAYMENT' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED'
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    version: bigint('version', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    ...auditTimestamps(),
  },
  (t) => [
    index('deposits_poll_idx')
      .on(t.nextPollAt)
      .where(sql`${t.status} <> 'SUCCEEDED' AND ${t.nextPollAt} IS NOT NULL`),
    index('deposits_verified_at_idx')
      .on(t.verifiedAt)
      .where(sql`${t.status} = 'SUCCEEDED'`),
    index('deposits_psp_ref_idx').on(t.pspRefId),
  ],
);

export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    currency: text('currency').notNull(), // 'IRT' | 'USDT'
    amount: numeric('amount', { precision: 38, scale: 0 }).notNull(),
    fee: numeric('fee', { precision: 38, scale: 0 }).notNull(),
    fxRateIrt: numeric('fx_rate_irt', { precision: 38, scale: 0 }).notNull(),
    irtEquivalent: numeric('irt_equivalent', {
      precision: 38,
      scale: 0,
    }).notNull(),
    limitDate: date('limit_date').notNull(),
    quotaReleased: boolean('quota_released').notNull().default(false),
    destination: text('destination').notNull(),
    providerRequestId: varchar('provider_request_id', { length: 64 })
      .notNull()
      .unique(),
    providerRefId: text('provider_ref_id'),
    status: text('status').notNull(), // 'PENDING_DISPATCH' | 'DISPATCHING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'MANUAL_REVIEW'
    failureReason: text('failure_reason'),
    lateSuccessConflict: boolean('late_success_conflict')
      .notNull()
      .default(false),
    version: bigint('version', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    ...auditTimestamps(),
  },
  (t) => [
    index('withdrawals_dispatch_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('PENDING_DISPATCH', 'DISPATCHING')`),
    index('withdrawals_poll_idx')
      .on(t.nextPollAt)
      .where(sql`${t.status} IN ('PROCESSING', 'MANUAL_REVIEW')`),
  ],
);

export const adjustments = pgTable('adjustments', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  currency: text('currency').notNull(),
  amount: numeric('amount', { precision: 38, scale: 0 }).notNull(),
  reason: text('reason').notNull(),
  operatorId: text('operator_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const financialDiscrepancies = pgTable(
  'financial_discrepancies',
  {
    id: uuid('id').primaryKey(),
    referenceType: text('reference_type').notNull(), // 'DEPOSIT' | 'WITHDRAWAL'
    referenceId: uuid('reference_id').notNull(),
    userId: text('user_id').notNull(),
    discrepancyType: text('discrepancy_type').notNull(), // 'AMOUNT_MISMATCH' | 'LATE_SUCCESS_CONFLICT'
    amount: numeric('amount', { precision: 38, scale: 0 }).notNull(),
    currency: text('currency').notNull(),
    providerPayload: jsonb('provider_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status').notNull().default('OPEN'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('financial_discrepancies_user_status_idx').on(t.userId, t.status),
  ],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey(),
    fromUserId: text('from_user_id').notNull(),
    toUserId: text('to_user_id').notNull(),
    currency: text('currency').notNull(),
    amount: numeric('amount', { precision: 38, scale: 0 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('transfers_from_user_created_idx').on(
      t.fromUserId,
      t.createdAt.desc(),
    ),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('PENDING'), // 'PENDING' | 'PUBLISHED'
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    consumerName: text('consumer_name').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.consumerName] })],
);

export const systemControls = pgTable('system_controls', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
