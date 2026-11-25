import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { Currency } from '../src/common/enums/domain.enums.js';
import { generateUuidV7 } from '../src/common/utils/uuidv7.util.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import { AmqpBrokerClient } from '../src/modules/outbox/amqp-broker.client.js';
import { BalanceEventConsumerService } from '../src/modules/outbox/balance-event-consumer.service.js';
import { OutboxPublisherService } from '../src/modules/outbox/outbox-publisher.service.js';
import { OutboxWorker } from '../src/modules/outbox/outbox.worker.js';
import {
  assertGlobalFinancialInvariants,
  fundUserViaAdjustment,
} from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
  resetTestDatabase,
} from './helpers/test-env.js';

describe('Transactional Outbox, Broker Outage Resilience & Idempotent Consumer (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let publisher: OutboxPublisherService;
  let consumer: BalanceEventConsumerService;

  const mockBroker = {
    publishEvent: vi.fn(),
    startConsumer: vi.fn(),
  };

  beforeAll(async () => {
    prepareTestEnv();
    const dbUri = getRequiredTestDatabaseUri();
    await runMigrations(dbUri);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AmqpBrokerClient)
      .useValue(mockBroker)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    database = app.get(DatabaseService);
    publisher = app.get(OutboxPublisherService);
    consumer = app.get(BalanceEventConsumerService);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTestDatabase(database.pool);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('commits balance changes when broker is down, schedules exponential backoff, and publishes once recovered', async () => {
    const alice = `outbox_a_${faker.string.alphanumeric(6)}`;
    const bob = `outbox_b_${faker.string.alphanumeric(6)}`;

    // Broker outage must NOT block HTTP 201 mutations
    mockBroker.publishEvent.mockRejectedValue(
      new Error('ECONNREFUSED amqp://guest:secret@127.0.0.1:5672'),
    );

    await fundUserViaAdjustment({
      app,
      userId: alice,
      currency: Currency.IRT,
      amount: '500000',
      idempotencyKey: `fund-${faker.string.uuid()}`,
    });

    await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-${faker.string.uuid()}`)
      .send({
        fromUserId: alice,
        toUserId: bob,
        currency: Currency.IRT,
        amount: '125000',
      })
      .expect(201);

    const failedBatch = await publisher.publishPendingBatch();
    expect(failedBatch).toEqual({ published: 0, failed: 2 });

    const { rows: afterFailure } = await database.pool.query<{
      status: string;
      retry_count: number;
      last_error: string | null;
    }>(
      `SELECT status, retry_count, last_error FROM outbox_events ORDER BY created_at ASC`,
    );
    expect(afterFailure).toHaveLength(2);
    for (const row of afterFailure) {
      expect(row.status).toBe('PENDING');
      expect(row.retry_count).toBe(1);
      expect(row.last_error).toContain('[REDACTED_AMQP_URI]');
      expect(row.last_error).not.toContain('guest:secret');
    }

    // Make retry due immediately and simulate broker recovery
    await database.pool.query(
      `UPDATE outbox_events SET next_retry_at = NOW() - INTERVAL '1 second'`,
    );
    mockBroker.publishEvent.mockResolvedValue(undefined);

    const recoveredBatch = await publisher.publishPendingBatch();
    expect(recoveredBatch).toEqual({ published: 2, failed: 0 });

    const { rows: afterPublish } = await database.pool.query<{
      status: string;
      published_at: Date | null;
    }>(`SELECT status, published_at FROM outbox_events`);
    expect(afterPublish).toHaveLength(2);
    for (const row of afterPublish) {
      expect(row.status).toBe('PUBLISHED');
      expect(row.published_at).not.toBeNull();
    }

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('deduplicates sequential and concurrent duplicate deliveries in processed_events', async () => {
    const eventId = generateUuidV7();
    const consumerName = 't103-balance-audit-consumer';
    const payload = { transactionId: generateUuidV7(), changes: [] };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumer.processEvent({ eventId, consumerName, payload }),
      ),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.filter((r) => !r.applied)).toHaveLength(9);

    const seqRepeat = await consumer.processEvent({
      eventId,
      consumerName,
      payload,
    });
    expect(seqRepeat).toEqual({ applied: false });

    const { rows } = await database.pool.query(
      `SELECT event_id FROM processed_events WHERE event_id = $1`,
      [eventId],
    );
    expect(rows).toHaveLength(1);
  });

  it('re-attempts AMQP consumer attach on OutboxWorker ticks after startup ECONNREFUSED (F-05)', async () => {
    const outboxWorker = app.get(OutboxWorker);
    mockBroker.startConsumer
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);

    await (
      outboxWorker as unknown as { runTick: () => Promise<void> }
    ).runTick();
    await (
      outboxWorker as unknown as { runTick: () => Promise<void> }
    ).runTick();

    expect(mockBroker.startConsumer).toHaveBeenCalledTimes(2);
  });
});
