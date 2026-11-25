import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { CurrencyEnum } from '../src/common/enums/currency.enum.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import {
  assertGlobalFinancialInvariants,
  fundUserViaAdjustment,
} from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
  resetTestDatabase,
} from './helpers/test-env.js';

const VALID_IBAN = 'IR062960000000100324200001';

describe('100-Concurrency PostgreSQL Lock & Limit Correctness (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let baseUrl: string;

  beforeAll(async () => {
    prepareTestEnv();
    const dbUri = getRequiredTestDatabaseUri();
    await runMigrations(dbUri);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    database = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetTestDatabase(database.pool);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function postWithdrawalConcurrent(params: {
    userId: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<{ httpStatus: number; code?: string; withdrawalId?: string }> {
    const res = await fetch(`${baseUrl}/withdrawals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': params.idempotencyKey,
      },
      body: JSON.stringify({
        userId: params.userId,
        currency: CurrencyEnum.IRT,
        amount: params.amount,
        destination: VALID_IBAN,
      }),
    });
    const body = (await res.json()) as {
      code?: string;
      withdrawalId?: string;
    };
    return {
      httpStatus: res.status,
      code: body.code,
      withdrawalId: body.withdrawalId,
    };
  }

  it('permits exactly 10 of 100 simultaneous withdrawals on 1,000,000 IRT balance with zero negative drift', async () => {
    const userId = `conc_bal_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: CurrencyEnum.IRT,
      amount: '1000000',
      idempotencyKey: `fund-bal-${faker.string.uuid()}`,
    });

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        postWithdrawalConcurrent({
          userId,
          amount: '100000',
          idempotencyKey: `conc-bal-${i}-${faker.string.uuid()}`,
        }),
      ),
    );

    const succeeded = responses.filter((r) => r.httpStatus === 201);
    const rejected = responses.filter(
      (r) => r.httpStatus === 422 && r.code === 'INSUFFICIENT_FUNDS',
    );
    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(90);

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: CurrencyEnum.IRT,
      available: '0',
      locked: '1000000',
      receivable: '0',
    });

    await assertGlobalFinancialInvariants(database.pool);
  }, 20_000);

  it('permits exactly 20 of 100 simultaneous 10M IRT withdrawals against 200M IRT daily limit', async () => {
    const userId = `conc_lim_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: CurrencyEnum.IRT,
      amount: '500000000',
      idempotencyKey: `fund-lim-${faker.string.uuid()}`,
    });

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        postWithdrawalConcurrent({
          userId,
          amount: '10000000',
          idempotencyKey: `conc-lim-${i}-${faker.string.uuid()}`,
        }),
      ),
    );

    const succeeded = responses.filter((r) => r.httpStatus === 201);
    const rejected = responses.filter(
      (r) => r.httpStatus === 422 && r.code === 'DAILY_LIMIT_EXCEEDED',
    );
    expect(succeeded).toHaveLength(20);
    expect(rejected).toHaveLength(80);

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: CurrencyEnum.IRT,
      available: '300000000',
      locked: '200000000',
      receivable: '0',
    });

    const { rows: limitRows } = await database.pool.query<{
      used_irt_amount: string;
    }>(`SELECT used_irt_amount FROM user_daily_limits WHERE user_id = $1`, [
      userId,
    ]);
    expect(limitRows[0]?.used_irt_amount).toBe('200000000');

    await assertGlobalFinancialInvariants(database.pool);
  }, 20_000);

  it('deduplicates 20 simultaneous identical POST /withdrawals with the same Idempotency-Key into one hold', async () => {
    const userId = `conc_idem_${faker.string.alphanumeric(8)}`;
    const sharedKey = `conc-same-${faker.string.uuid()}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: CurrencyEnum.IRT,
      amount: '100000',
      idempotencyKey: `fund-idem-${faker.string.uuid()}`,
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        postWithdrawalConcurrent({
          userId,
          amount: '100000',
          idempotencyKey: sharedKey,
        }),
      ),
    );

    const firstId = responses[0]?.withdrawalId;
    expect(firstId).toEqual(expect.any(String));
    for (const r of responses) {
      expect(r.httpStatus).toBe(201);
      expect(r.withdrawalId).toBe(firstId);
    }

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: CurrencyEnum.IRT,
      available: '0',
      locked: '100000',
      receivable: '0',
    });

    await assertGlobalFinancialInvariants(database.pool);
  }, 20_000);
});
