import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { generateUuidV7 } from '../src/common/utils/uuidv7.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import { DepositService } from '../src/modules/deposit/deposit.service.js';
import { AmqpBrokerClient } from '../src/modules/outbox/amqp-broker.client.js';
import { BalanceEventConsumerService } from '../src/modules/outbox/balance-event-consumer.service.js';
import { OutboxPublisherService } from '../src/modules/outbox/outbox-publisher.service.js';
import { WithdrawalService } from '../src/modules/withdrawal/withdrawal.service.js';
import {
  assertGlobalFinancialInvariants,
  fundUserViaAdjustment,
} from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
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
    let depositService: DepositService;
    let withdrawalService: WithdrawalService;
    let outboxPublisher: OutboxPublisherService;
    let consumerService: BalanceEventConsumerService;
    let brokerClient: AmqpBrokerClient;
    let pspBaseUrl: string;

    beforeAll(async () => {
      prepareTestEnv();
      const port = Number(process.env.HOSTILE_TEST_APP_PORT ?? 3999);
      process.env.APP_PUBLIC_URL = `http://host.docker.internal:${port}`;
      process.env.WORKERS_ENABLED = 'false';
      process.env.WD_MANUAL_REVIEW_SLA_MS = '8000';

      const dbUri = getRequiredTestDatabaseUri();
      await runMigrations(dbUri);

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication({ rawBody: true });
      configureApp(app);
      await app.listen(port, '0.0.0.0');

      database = app.get(DatabaseService);
      depositService = app.get(DepositService);
      withdrawalService = app.get(WithdrawalService);
      outboxPublisher = app.get(OutboxPublisherService);
      consumerService = app.get(BalanceEventConsumerService);
      brokerClient = app.get(AmqpBrokerClient);
      pspBaseUrl = process.env.PSP_BASE_URL ?? 'http://127.0.0.1:8080';

      await resetTestDatabase(database.pool);
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
    }, 20_000);

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

    it('survives hostile PSP/Payout chaos, dirty settlement CSV, RabbitMQ delivery & dedup, and preserves all ledger invariants', async () => {
      const userA = `hostile_a_${faker.string.alphanumeric(6)}`;
      const userB = `hostile_b_${faker.string.alphanumeric(6)}`;

      // 1. Live hostile PSP deposits (3 paid, 1 failed, 1 unpaid)
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

      const depositDeadline = Date.now() + 25_000;
      let allDepositsSettled = false;
      while (Date.now() < depositDeadline && !allDepositsSettled) {
        await depositService.pollPendingDeposits(20);
        for (const id of [...paidIds, failDep.depositId, unpaidDep.depositId]) {
          await depositService.verifyDeposit(id).catch(() => undefined);
        }
        const paidStatuses = await Promise.all(
          paidIds.map((id) => depositService.getDeposit(id)),
        );
        const failStatus = await depositService.getDeposit(failDep.depositId);
        allDepositsSettled =
          paidStatuses.every((s) => s.status === 'SUCCEEDED') &&
          failStatus.status === 'FAILED';
        if (!allDepositsSettled) {
          await sleep(250);
        }
      }
      expect(allDepositsSettled).toBe(true);

      const failDetail = await depositService.getDeposit(failDep.depositId);
      expect(failDetail.status).toBe('FAILED');
      const unpaidDetail = await depositService.getDeposit(unpaidDep.depositId);
      expect(unpaidDetail.status).not.toBe('SUCCEEDED');

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

      // 3. Live hostile IRT + USDT withdrawals
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

      const wdDeadline = Date.now() + 25_000;
      let nonConvergedWithdrawals = [] as Awaited<
        ReturnType<typeof withdrawalService.getWithdrawal>
      >[];
      while (Date.now() < wdDeadline) {
        await database.pool.query(`
          UPDATE withdrawals
          SET lease_until = CASE
            WHEN status = 'DISPATCHING' AND updated_at <= NOW() - INTERVAL '1 second'
            THEN NOW() - INTERVAL '1 second'
            ELSE lease_until
          END,
          next_poll_at = CASE
            WHEN status IN ('PROCESSING', 'MANUAL_REVIEW')
            THEN NOW() - INTERVAL '1 second'
            ELSE next_poll_at
          END
        `);
        await withdrawalService.dispatchPendingBatch(10);
        await withdrawalService.pollProcessingBatch(10);
        const details = await Promise.all(
          wdIds.map((id) => withdrawalService.getWithdrawal(id)),
        );
        nonConvergedWithdrawals = details.filter(
          (d) =>
            d.status !== 'SUCCEEDED' &&
            d.status !== 'FAILED' &&
            d.status !== 'MANUAL_REVIEW',
        );
        if (nonConvergedWithdrawals.length === 0) {
          break;
        }
        await sleep(300);
      }
      expect(nonConvergedWithdrawals).toEqual([]);

      // 4. Live dirty Persian settlement CSV reconciliation
      const utcDate = new Date().toISOString().slice(0, 10);
      const recRes = await request(app.getHttpServer())
        .post('/reconciliation/run')
        .send({ date: utcDate })
        .expect(200);
      expect(recRes.body.date).toBe(utcDate);
      expect(Array.isArray(recRes.body.mismatches)).toBe(true);

      // 5. Live RabbitMQ outbox flush & idempotent consumer consumption
      for (let round = 0; round < 5; round += 1) {
        const batch = await outboxPublisher.publishPendingBatch(100);
        if (batch.published === 0 && batch.failed === 0) {
          break;
        }
        await database.pool.query(
          `UPDATE outbox_events SET next_retry_at = NOW() WHERE status = 'PENDING'`,
        );
      }

      const { rows: pendingOutbox } = await database.pool.query(
        `SELECT id, status, retry_count, last_error FROM outbox_events WHERE status != 'PUBLISHED'`,
      );
      expect(pendingOutbox).toEqual([]);

      await brokerClient.startConsumer(async ({ eventId, payload }) => {
        await consumerService.processEvent({
          eventId,
          consumerName: 'hostile-e2e-consumer',
          payload,
        });
      });

      const consumeDeadline = Date.now() + 8_000;
      while (Date.now() < consumeDeadline) {
        const { rows: countRows } = await database.pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM processed_events WHERE consumer_name = 'hostile-e2e-consumer'`,
        );
        if (Number(countRows[0]?.cnt ?? 0) > 0) {
          break;
        }
        await sleep(150);
      }

      const dupTestId = generateUuidV7();
      const firstApply = await consumerService.processEvent({
        eventId: dupTestId,
        consumerName: 'hostile-e2e-consumer',
        payload: { check: true },
      });
      const dupApply = await consumerService.processEvent({
        eventId: dupTestId,
        consumerName: 'hostile-e2e-consumer',
        payload: { check: true },
      });
      expect(firstApply).toEqual({ applied: true });
      expect(dupApply).toEqual({ applied: false });

      // 6. Verify all financial invariants globally across DB
      await assertGlobalFinancialInvariants(database.pool);
    }, 95_000);
  },
);
