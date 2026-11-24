import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import type { AmqpBrokerClient } from './amqp-broker.client.js';
import type { BalanceEventConsumerService } from './balance-event-consumer.service.js';
import type { OutboxPublisherService } from './outbox-publisher.service.js';
import { OutboxWorker } from './outbox.worker.js';

class TestableOutboxWorker extends OutboxWorker {
  async tickForTest(): Promise<void> {
    await this.runTick();
  }
}

describe('OutboxWorker consumer auto-reconnect (F-05)', () => {
  it('retries startConsumer on every runTick so startup ECONNREFUSED and mid-run disconnects recover', async () => {
    const configService = {
      get: (key: keyof EnvConfig) => (key === 'WORKERS_ENABLED' ? true : 1_000),
    } as unknown as ConfigService<EnvConfig, true>;

    const publishPendingBatch = vi
      .fn()
      .mockResolvedValue({ published: 0, failed: 0 });
    const publisher = {
      publishPendingBatch,
    } as unknown as OutboxPublisherService;

    const startConsumer = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);
    const broker = { startConsumer } as unknown as AmqpBrokerClient;

    const processEvent = vi.fn().mockResolvedValue({ applied: true });
    const consumer = { processEvent } as unknown as BalanceEventConsumerService;

    const worker = new TestableOutboxWorker(
      configService,
      publisher,
      broker,
      consumer,
    );

    worker.onModuleInit();
    await worker.tickForTest();
    await worker.tickForTest();

    expect(startConsumer).toHaveBeenCalledTimes(3);
    expect(publishPendingBatch).toHaveBeenCalledTimes(2);
  });
});
