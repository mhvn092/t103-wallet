import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AmqpBrokerClient } from './amqp-broker.client.js';
import { BalanceEventConsumerService } from './balance-event-consumer.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import { OutboxWorker } from './outbox.worker.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    AmqpBrokerClient,
    OutboxPublisherService,
    BalanceEventConsumerService,
    OutboxWorker,
  ],
  exports: [OutboxPublisherService, BalanceEventConsumerService],
})
export class OutboxModule {}
