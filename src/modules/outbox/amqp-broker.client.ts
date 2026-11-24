import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  connect,
} from 'amqplib';
import type { EnvConfig } from '../../config/env.validation.js';

const OUTBOX_EXCHANGE = 't103.wallet.events';
const OUTBOX_QUEUE = 't103.balance.audit';
const BALANCE_CHANGED_ROUTING_KEY = 'balance.changed';

function sanitizeBrokerError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/amqps?:\/\/[^\s]+/gi, '[REDACTED_AMQP_URI]');
}

@Injectable()
export class AmqpBrokerClient implements OnModuleDestroy {
  constructor(private readonly _config: ConfigService<EnvConfig, true>) {}

  async publishEvent(
    eventId: string,
    routingKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const channel = await this._ensurePublishChannel();
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      channel.publish(OUTBOX_EXCHANGE, routingKey, body, {
        persistent: true,
        messageId: eventId,
        contentType: 'application/json',
        timestamp: Math.floor(Date.now() / 1000),
      });
      await channel.waitForConfirms();
    } catch (err) {
      await this._closeQuietly();
      throw new Error(sanitizeBrokerError(err));
    }
  }

  async startConsumer(
    handler: (msg: { eventId: string; payload: unknown }) => Promise<void>,
  ): Promise<void> {
    try {
      const conn = await this._ensureConnection();
      const ch = await conn.createChannel();
      await this._assertTopology(ch);
      await ch.prefetch(10);
      await ch.consume(OUTBOX_QUEUE, (rawMsg) => {
        if (!rawMsg) {
          return;
        }
        void this._handleDelivery(ch, rawMsg, handler);
      });
      this._consumerChannel = ch;
    } catch (err) {
      this._logger.warn(
        `AMQP consumer unavailable at startup (non-blocking): ${sanitizeBrokerError(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this._closeQuietly();
  }

  private async _ensureConnection(): Promise<ChannelModel> {
    if (this._connection) {
      return this._connection;
    }
    const uri = this._config.get('RABBITMQ_URI', { infer: true });
    const conn = await connect(uri, { timeout: 5_000 });
    conn.on('error', (err) => {
      this._logger.warn(`AMQP connection error: ${sanitizeBrokerError(err)}`);
    });
    conn.on('close', () => {
      this._connection = null;
      this._publishChannel = null;
      this._consumerChannel = null;
    });
    this._connection = conn;
    return conn;
  }

  private async _ensurePublishChannel(): Promise<ConfirmChannel> {
    if (this._publishChannel) {
      return this._publishChannel;
    }
    const conn = await this._ensureConnection();
    const channel = await conn.createConfirmChannel();
    await this._assertTopology(channel);
    this._publishChannel = channel;
    return channel;
  }

  private async _assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(OUTBOX_EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue(OUTBOX_QUEUE, { durable: true });
    await channel.bindQueue(
      OUTBOX_QUEUE,
      OUTBOX_EXCHANGE,
      BALANCE_CHANGED_ROUTING_KEY,
    );
  }

  private async _handleDelivery(
    channel: Channel,
    rawMsg: ConsumeMessage,
    handler: (msg: { eventId: string; payload: unknown }) => Promise<void>,
  ): Promise<void> {
    const rawEventId =
      typeof rawMsg.properties.messageId === 'string'
        ? rawMsg.properties.messageId
        : '';
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(rawMsg.content.toString('utf8'));
    } catch {
      channel.nack(rawMsg, false, false);
      return;
    }

    if (!rawEventId) {
      channel.nack(rawMsg, false, false);
      return;
    }

    try {
      await handler({ eventId: rawEventId, payload: parsedPayload });
      channel.ack(rawMsg);
    } catch (err) {
      this._logger.warn(
        `AMQP consumer deferred delivery for event=${rawEventId}: ${sanitizeBrokerError(err)}`,
      );
      channel.nack(rawMsg, false, true);
    }
  }

  private async _closeQuietly(): Promise<void> {
    const pub = this._publishChannel;
    const sub = this._consumerChannel;
    const conn = this._connection;
    this._publishChannel = null;
    this._consumerChannel = null;
    this._connection = null;

    await Promise.all([
      pub?.close().catch(() => undefined),
      sub?.close().catch(() => undefined),
      conn?.close().catch(() => undefined),
    ]);
  }

  private _connection: ChannelModel | null = null;
  private _publishChannel: ConfirmChannel | null = null;
  private _consumerChannel: Channel | null = null;
  private readonly _logger = new Logger(AmqpBrokerClient.name);
}
