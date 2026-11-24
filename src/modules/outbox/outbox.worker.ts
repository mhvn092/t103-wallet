import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntervalWorkerBase } from '../../common/workers/interval-worker.base.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { AmqpBrokerClient } from './amqp-broker.client.js';
import { BalanceEventConsumerService } from './balance-event-consumer.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

@Injectable()
export class OutboxWorker extends IntervalWorkerBase {
  protected readonly workerName = OutboxWorker.name;

  constructor(
    private readonly _config: ConfigService<EnvConfig, true>,
    private readonly _publisher: OutboxPublisherService,
    private readonly _broker: AmqpBrokerClient,
    private readonly _consumer: BalanceEventConsumerService,
  ) {
    super(_config);
  }

  override onModuleInit(): void {
    super.onModuleInit();
    if (!this._config.get('WORKERS_ENABLED', { infer: true })) {
      return;
    }
    void this._broker.startConsumer(async ({ eventId, payload }) => {
      await this._consumer.processEvent({
        eventId,
        consumerName: 't103-balance-audit-consumer',
        payload,
      });
    });
  }

  protected async runTick(): Promise<void> {
    await this._publisher.publishPendingBatch();
  }
}
