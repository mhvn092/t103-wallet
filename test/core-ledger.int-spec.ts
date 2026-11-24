import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { generateUuidV7 } from '../src/common/utils/uuidv7.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://t103:t103_secret@localhost:5432/t103_wallet';

describe('Core Ledger Invariants, Wallets, Idempotency & Ops Adjustments (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    await runMigrations(TEST_DB_URL);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query(`
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects direct SQL updates to accounts.balance via pg_trigger_depth() trigger', async () => {
    const accountId = generateUuidV7();
    await database.pool.query(
      `INSERT INTO accounts (id, owner_type, owner_id, currency, account_type, normal_side, balance)
       VALUES ($1, 'USER', 'u_direct', 'IRT', 'AVAILABLE', 'CREDIT', 0)`,
      [accountId],
    );

    await expect(
      database.pool.query(`UPDATE accounts SET balance = 999999 WHERE id = $1`, [
        accountId,
      ]),
    ).rejects.toThrow(/Direct updates to accounts\.balance are forbidden/);
  });

  it('rejects unbalanced or cross-currency ledger transactions at COMMIT', async () => {
    const u1 = generateUuidV7();
    await database.pool.query(
      `INSERT INTO accounts (id, owner_type, owner_id, currency, account_type, normal_side, balance)
       VALUES ($1, 'USER', 'u_unbal', 'USDT', 'AVAILABLE', 'CREDIT', 0)`,
      [u1],
    );

    // Cross-currency unbalanced TX (IRT clearing DEBIT vs USDT user CREDIT)
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const txId = generateUuidV7();
      await client.query(
        `INSERT INTO ledger_transactions (id, type, reference_type, reference_id, description)
         VALUES ($1, 'OPS_ADJ', 'ADJUSTMENT', $2, 'bad cross ccy')`,
        [txId, generateUuidV7()],
      );
      await client.query(
        `INSERT INTO ledger_items (transaction_id, account_id, user_id, account_type, currency, direction, amount)
         VALUES ($1, '01900000-0000-7000-8000-000000000003', NULL, 'ADJUSTMENT', 'IRT', 'DEBIT', 1000)`,
        [txId],
      );
      await client.query(
        `INSERT INTO ledger_items (transaction_id, account_id, user_id, account_type, currency, direction, amount)
         VALUES ($1, $2, 'u_unbal', 'AVAILABLE', 'USDT', 'CREDIT', 1000)`,
        [txId, u1],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('rejects negative USER AVAILABLE balances and post-commit item appends', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/adjustments')
      .set('Idempotency-Key', 'adj-seed-neg')
      .send({
        userId: 'u_neg',
        currency: 'IRT',
        amount: '1000',
        reason: 'seed',
      })
      .expect(201);
    expect(res.body.amount).toBe('1000');

    const { rows: accRows } = await database.pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE owner_type = 'USER' AND owner_id = 'u_neg' AND currency = 'IRT'`,
    );
    const uAccId = accRows[0]!.id;

    // 1. Over-debiting USER:AVAILABLE must violate accounts_owner_balance_chk (>= 0)
    const c1 = await database.pool.connect();
    try {
      await c1.query('BEGIN');
      const txId = generateUuidV7();
      await c1.query(
        `INSERT INTO ledger_transactions (id, type, reference_type, reference_id, description)
         VALUES ($1, 'WD_HOLD', 'WITHDRAWAL', $2, 'overdraw')`,
        [txId, generateUuidV7()],
      );
      await expect(
        c1.query(
          `INSERT INTO ledger_items (transaction_id, account_id, user_id, account_type, currency, direction, amount)
           VALUES ($1, $2, 'u_neg', 'AVAILABLE', 'IRT', 'DEBIT', 1001)`,
          [txId, uAccId],
        ),
      ).rejects.toThrow(/accounts_owner_balance_chk/);
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      c1.release();
    }

    // 2. Appending an item to a previously committed transaction must be rejected
    const { rows: txRows } = await database.pool.query<{ id: string }>(
      `SELECT id FROM ledger_transactions LIMIT 1`,
    );
    await expect(
      database.pool.query(
        `INSERT INTO ledger_items (transaction_id, account_id, user_id, account_type, currency, direction, amount)
         VALUES ($1, $2, 'u_neg', 'AVAILABLE', 'IRT', 'CREDIT', 500)`,
        [txRows[0]!.id, uAccId],
      ),
    ).rejects.toThrow(/outside the creating transaction/);
  });

  it('handles /internal/adjustments, concurrent idempotency replay, key reuse 422, wallet balances, and keyset ledger pagination', async () => {
    // Unseen user wallet returns 200 with zero balances & /ready is 200
    await request(app.getHttpServer()).get('/ready').expect(200);
    const emptyWallet = await request(app.getHttpServer())
      .get('/wallets/unseen_user')
      .expect(200);
    expect(emptyWallet.body).toEqual({
      userId: 'unseen_user',
      balances: [
        { currency: 'IRT', available: '0', locked: '0', receivable: '0' },
        { currency: 'USDT', available: '0', locked: '0', receivable: '0' },
      ],
    });

    // Missing Idempotency-Key returns 400 MISSING_IDEMPOTENCY_KEY
    const missingKey = await request(app.getHttpServer())
      .post('/internal/adjustments')
      .send({ userId: 'alice', currency: 'IRT', amount: '50000', reason: 'comp' })
      .expect(400);
    expect(missingKey.body.code).toBe('MISSING_IDEMPOTENCY_KEY');

    // Fire 5 simultaneous identical requests with same Idempotency-Key
    const payload = {
      userId: 'alice',
      currency: 'IRT',
      amount: '500000',
      reason: 'compensation',
    };
    const concurrentResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/internal/adjustments')
          .set('Idempotency-Key', 'idem-concurrent-adj-1')
          .set('X-Operator-Id', 'ops-ehsan')
          .send(payload),
      ),
    );
    for (const r of concurrentResults) {
      expect(r.status).toBe(201);
      expect(r.body.adjustmentId).toBe(concurrentResults[0]!.body.adjustmentId);
    }

    // Reusing same key with different payload yields 422 IDEMPOTENCY_KEY_REUSED
    const reused = await request(app.getHttpServer())
      .post('/internal/adjustments')
      .set('Idempotency-Key', 'idem-concurrent-adj-1')
      .send({ ...payload, amount: '999999' })
      .expect(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Add 2 more adjustments (including 6-decimal USDT) to test keyset pagination
    await request(app.getHttpServer())
      .post('/internal/adjustments')
      .set('Idempotency-Key', 'idem-adj-2')
      .send({
        userId: 'alice',
        currency: 'USDT',
        amount: '12.345678',
        reason: 'bonus usdt',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/internal/adjustments')
      .set('Idempotency-Key', 'idem-adj-3')
      .send({
        userId: 'alice',
        currency: 'IRT',
        amount: '250000',
        reason: 'second irt comp',
      })
      .expect(201);

    // Check wallet balances (should be 750000 IRT and 12.345678 USDT)
    const walletRes = await request(app.getHttpServer())
      .get('/wallets/alice')
      .expect(200);
    expect(walletRes.body.balances).toEqual([
      { currency: 'IRT', available: '750000', locked: '0', receivable: '0' },
      {
        currency: 'USDT',
        available: '12.345678',
        locked: '0',
        receivable: '0',
      },
    ]);

    // Check keyset pagination across the 3 ledger items (limit=2 -> nextCursor -> page 2)
    const page1 = await request(app.getHttpServer())
      .get('/wallets/alice/ledger?limit=2')
      .expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].amount).toBe('250000');
    expect(page1.body.items[0].balanceAfter).toBe('750000');
    expect(page1.body.items[1].amount).toBe('12.345678');
    expect(page1.body.nextCursor).toBe(page1.body.items[1].id);

    const page2 = await request(app.getHttpServer())
      .get(`/wallets/alice/ledger?limit=2&cursor=${page1.body.nextCursor}`)
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].amount).toBe('500000');
    expect(page2.body.nextCursor).toBeNull();

    // Outbox events written atomically in the same transactions (3 events for 3 user credits)
    const { rows: outboxRows } = await database.pool.query(
      `SELECT event_type, status FROM outbox_events ORDER BY created_at ASC`,
    );
    expect(outboxRows).toHaveLength(3);
    expect(outboxRows[0]).toEqual({
      event_type: 'BALANCE_CHANGED',
      status: 'PENDING',
    });
  });
});
