import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export function getRequiredTestDatabaseUri(): string {
  const uri = process.env.DATABASE_URI;
  if (!uri) {
    throw new Error(
      'DATABASE_URI environment variable must be set before running integration/e2e tests',
    );
  }
  return uri;
}

export function prepareTestEnv(): void {
  if (!process.env.WEBHOOK_SECRET) {
    process.env.WEBHOOK_SECRET = randomBytes(24).toString('hex');
  }
  if (!process.env.RABBITMQ_URI) {
    process.env.RABBITMQ_URI = 'amqp://127.0.0.1:5672';
  }
  if (!process.env.WORKERS_ENABLED) {
    process.env.WORKERS_ENABLED = 'false';
  }
}

export async function resetTestDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      ledger_items,
      ledger_transactions,
      adjustments,
      deposits,
      withdrawals,
      transfers,
      financial_discrepancies,
      outbox_events,
      processed_events,
      idempotency_keys,
      user_daily_limits,
      user_restrictions
    CASCADE;
    DELETE FROM accounts WHERE owner_type = 'USER';
  `);
}
