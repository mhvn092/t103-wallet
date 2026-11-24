import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { generateUuidV7 } from '../src/common/utils/uuidv7.util.js';
import type { EnvConfig } from '../src/config/env.validation.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import { BalanceEventConsumerService } from '../src/modules/outbox/balance-event-consumer.service.js';
import {
  assertGlobalFinancialInvariants,
  fundUserViaAdjustment,
} from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  resetTestDatabase,
} from './helpers/test-env.js';

const IS_LIVE = process.env.LIVE_SIMULATOR_E2E === 'true';
const VALID_IBAN = 'IR062960000000100324200001';
const VALID_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryPspPayAction(
  pspBaseUrl: string,
  token: string,
  result: 'success' | 'fail',
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(
        `${pspBaseUrl}/psp/pay/${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (res.ok || res.status < 500) {
        return;
      }
    } catch {
      // Transient simulator drop in hostile mode; retry cleanly
    }
    await sleep(200);
  }
}

describe.runIf(IS_LIVE)(
  'Live Hostile Simulator + RabbitMQ + PostgreSQL Chaos Suite (E2E)',
  () => {
    let app: INestApplication<App>;
    let database: DatabaseService;
    let consumerService: BalanceEventConsumerService;
    let pspBaseUrl: string;

    beforeAll(async () => {
      const port = Number(process.env.HOSTILE_TEST_APP_PORT ?? 3999);

      const dbUri = getRequiredTestDatabaseUri();
      await runMigrations(dbUri);

      const initPool = new Pool({ connectionString: dbUri });
      try {
        await resetTestDatabase(initPool);
      } finally {
        await initPool.end();
      }

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication({ rawBody: true });
      configureApp(app);
      await app.listen(port, '0.0.0.0');

      const config = app.get(ConfigService<EnvConfig, true>);
      expect(config.get('WORKERS_ENABLED', { infer: true })).toBe(true);

      database = app.get(DatabaseService);
      consumerService = app.get(BalanceEventConsumerService);
      pspBaseUrl = process.env.PSP_BASE_URL ?? 'http://127.0.0.1:8080';
    });

    afterAll(async () => {
      if (app) {
        const httpServer: unknown = app.getHttpServer();
        if (
          typeof httpServer === 'object' &&
          httpServer !== null &&
          'closeIdleConnections' in httpServer &&
          typeof httpServer.closeIdleConnections === 'function'
        ) {
          httpServer.closeIdleConnections();
        }
        await app.close();
      }
    }, 25_000);

    async function createDepositWithRetry(
      userId: string,
      amount: string,
    ): Promise<{ depositId: string; pspToken: string }> {
      const idemKey = `hostile-dep-${faker.string.uuid()}`;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await request(app.getHttpServer())
          .post('/deposits')
          .set('Idempotency-Key', idemKey)
          .send({ userId, amount });
        if (res.status === 201) {
          const detail = await request(app.getHttpServer())
            .get(`/deposits/${res.body.depositId}`)
            .expect(200);
          return {
            depositId: res.body.depositId as string,
            pspToken: detail.body.pspToken as string,
          };
        }
        await sleep(250);
      }
      throw new Error('Deposit initiation exhausted hostile retries');
    }

    it('converges autonomously under hostile PSP/Payout chaos with WORKERS_ENABLED=true, dirty CSV reconciliation, RabbitMQ delivery, and zero SQL shortcuts', async () => {
      const userA = `hostile_a_${faker.string.alphanumeric(6)}`;
      const userB = `hostile_b_${faker.string.alphanumeric(6)}`;

      // 1. Live hostile PSP deposits (3 paid, 1 failed, 1 unpaid) settled autonomously by DepositPoller
      const paidIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const dep = await createDepositWithRetry(
          userA,
          String(100_000 + i * 10_000),
        );
        await retryPspPayAction(pspBaseUrl, dep.pspToken, 'success');
        paidIds.push(dep.depositId);
      }

      const failDep = await createDepositWithRetry(userA, '150000');
      await retryPspPayAction(pspBaseUrl, failDep.pspToken, 'fail');

      const unpaidDep = await createDepositWithRetry(userA, '160000');

      const depositDeadline = Date.now() + 30_000;
      let allDepositsSettled = false;
      while (Date.now() < depositDeadline && !allDepositsSettled) {
        const paidResponses = await Promise.all(
          paidIds.map((id) =>
            request(app.getHttpServer()).get(`/deposits/${id}`).expect(200),
          ),
        );
        const failResponse = await request(app.getHttpServer())
          .get(`/deposits/${failDep.depositId}`)
          .expect(200);
        allDepositsSettled =
          paidResponses.every((r) => r.body.status === 'SUCCEEDED') &&
          failResponse.body.status === 'FAILED';
        if (!allDepositsSettled) {
          await sleep(400);
        }
      }
      expect(allDepositsSettled).toBe(true);

      const unpaidDetail = await request(app.getHttpServer())
        .get(`/deposits/${unpaidDep.depositId}`)
        .expect(200);
      expect(unpaidDetail.body.status).not.toBe('SUCCEEDED');

      // 2. Atomic internal transfer & funding for withdrawals
      await request(app.getHttpServer())
        .post('/transfers')
        .set('Idempotency-Key', `hostile-xfer-${faker.string.uuid()}`)
        .send({
          fromUserId: userA,
          toUserId: userB,
          currency: 'IRT',
          amount: '25000',
        })
        .expect(201);

      await fundUserViaAdjustment({
        app,
        userId: userA,
        currency: 'IRT',
        amount: '2000000',
        idempotencyKey: `hostile-fund-irt-${faker.string.uuid()}`,
      });
      await fundUserViaAdjustment({
        app,
        userId: userA,
        currency: 'USDT',
        amount: '50',
        idempotencyKey: `hostile-fund-usdt-${faker.string.uuid()}`,
      });

      // 3. Live hostile IRT + USDT withdrawals converged autonomously by WithdrawalWorker (zero SQL lease overrides)
      const wdIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/withdrawals')
          .set('Idempotency-Key', `hostile-wd-irt-${i}-${faker.string.uuid()}`)
          .send({
            userId: userA,
            currency: 'IRT',
            amount: '150000',
            destination: VALID_IBAN,
          })
          .expect(201);
        wdIds.push(res.body.withdrawalId as string);
      }

      for (let i = 0; i < 2; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/withdrawals')
          .set('Idempotency-Key', `hostile-wd-usdt-${i}-${faker.string.uuid()}`)
          .send({
            userId: userA,
            currency: 'USDT',
            amount: '10.5',
            destination: VALID_TRC20,
          })
          .expect(201);
        wdIds.push(res.body.withdrawalId as string);
      }

      const wdDeadline = Date.now() + 45_000;
      let nonConvergedCount = wdIds.length;
      while (Date.now() < wdDeadline) {
        const responses = await Promise.all(
          wdIds.map((id) =>
            request(app.getHttpServer()).get(`/withdrawals/${id}`).expect(200),
          ),
        );
        nonConvergedCount = responses.filter(
          (r) =>
            r.body.status !== 'SUCCEEDED' &&
            r.body.status !== 'FAILED' &&
            r.body.status !== 'MANUAL_REVIEW',
        ).length;
        if (nonConvergedCount === 0) {
          break;
        }
        await sleep(500);
      }
      expect(nonConvergedCount).toBe(0);

      // 4. Live dirty Persian settlement CSV reconciliation
      const utcDate = new Date().toISOString().slice(0, 10);
      const recRes = await request(app.getHttpServer())
        .post('/reconciliation/run')
        .send({ date: utcDate })
        .expect(200);
      expect(recRes.body.date).toBe(utcDate);
      expect(Array.isArray(recRes.body.mismatches)).toBe(true);

      // 5. Autonomous OutboxWorker publishing to RabbitMQ + built-in consumer dedup verification
      const outboxDeadline = Date.now() + 20_000;
      let pendingOutboxCount = 1;
      while (Date.now() < outboxDeadline) {
        const { rows } = await database.pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM outbox_events WHERE status != 'PUBLISHED'`,
        );
        pendingOutboxCount = Number(rows[0]?.cnt ?? 0);
        if (pendingOutboxCount === 0) {
          break;
        }
        await sleep(400);
      }
      expect(pendingOutboxCount).toBe(0);

      const consumeDeadline = Date.now() + 10_000;
      let consumedCount = 0;
      while (Date.now() < consumeDeadline) {
        const { rows } = await database.pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM processed_events WHERE consumer_name = 't103-balance-audit-consumer'`,
        );
        consumedCount = Number(rows[0]?.cnt ?? 0);
        if (consumedCount > 0) {
          break;
        }
        await sleep(250);
      }
      expect(consumedCount).toBeGreaterThan(0);

      const dupTestId = generateUuidV7();
      const firstApply = await consumerService.processEvent({
        eventId: dupTestId,
        consumerName: 't103-balance-audit-consumer',
        payload: { check: true },
      });
      const dupApply = await consumerService.processEvent({
        eventId: dupTestId,
        consumerName: 't103-balance-audit-consumer',
        payload: { check: true },
      });
      expect(firstApply).toEqual({ applied: true });
      expect(dupApply).toEqual({ applied: false });

      // 6. Verify all financial invariants globally & /internal/metrics reports 0 balance drift
      const metricsRes = await request(app.getHttpServer())
        .get('/internal/metrics')
        .expect(200);
      expect(metricsRes.body.balanceDriftAccounts).toBe(0);

      await assertGlobalFinancialInvariants(database.pool);
    }, 120_000);
  },
);
