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
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _outboxPublisherService: OutboxPublisherService,
    private readonly _amqpBrokerClient: AmqpBrokerClient,
    private readonly _balanceEventConsumerService: BalanceEventConsumerService,
  ) {
    super(_configService);
  }

  override onModuleInit(): void {
    super.onModuleInit();
    if (!this._configService.get('WORKERS_ENABLED', { infer: true })) {
      return;
    }
    void this._amqpBrokerClient.startConsumer(this._handleConsumedEvent);
  }

  protected async runTick(): Promise<void> {
    try {
      await this._amqpBrokerClient.startConsumer(this._handleConsumedEvent);
    } catch {
      // Non-blocking: publisher outbox relay still proceeds and next tick retries consumer attach
    }
    await this._outboxPublisherService.publishPendingBatch();
  }

  private readonly _handleConsumedEvent = async (msg: {
    eventId: string;
    payload: unknown;
  }): Promise<void> => {
    await this._balanceEventConsumerService.processEvent({
      eventId: msg.eventId,
      consumerName: 't103-balance-audit-consumer',
      payload: msg.payload,
    });
  };
}
