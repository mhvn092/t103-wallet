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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE ledger_items DISABLE TRIGGER trg_ledger_items_no_truncate',
    );
    await client.query(
      'ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_no_truncate',
    );
    await client.query(`
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
        user_restrictions,
        system_controls
      CASCADE
    `);
    await client.query(`DELETE FROM accounts WHERE owner_type = 'USER'`);
    await client.query(
      'ALTER TABLE ledger_items ENABLE TRIGGER trg_ledger_items_no_truncate',
    );
    await client.query(
      'ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_no_truncate',
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
