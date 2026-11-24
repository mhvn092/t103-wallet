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
import { sanitizeBrokerError } from './amqp-error.util.js';
import {
  BALANCE_CHANGED_ROUTING_KEY,
  OUTBOX_EXCHANGE,
  OUTBOX_QUEUE,
} from './outbox.constants.js';

const UNAVAILABLE_LOG_INTERVAL_MS = 30_000;

@Injectable()
export class AmqpBrokerClient implements OnModuleDestroy {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
  ) {}

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
    if (this._destroyed || this._consumerChannel !== null) {
      return;
    }
    if (this._consumerStartInFlight) {
      return this._consumerStartInFlight;
    }

    const promise = (async () => {
      try {
        const conn = await this._ensureConnection();
        if (this._destroyed || this._consumerChannel !== null) {
          return;
        }
        const ch = await conn.createChannel();
        ch.on('error', (err) => {
          this._logger.warn(
            `AMQP consumer channel error: ${sanitizeBrokerError(err)}`,
          );
          if (this._consumerChannel === ch) {
            this._consumerChannel = null;
          }
        });
        ch.on('close', () => {
          if (this._consumerChannel === ch) {
            this._consumerChannel = null;
          }
        });
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
        this._consumerChannel = null;
        const nowMs = Date.now();
        if (
          nowMs - this._lastUnavailableLogAtMs >=
          UNAVAILABLE_LOG_INTERVAL_MS
        ) {
          this._lastUnavailableLogAtMs = nowMs;
          this._logger.warn(
            `AMQP consumer unavailable (will retry): ${sanitizeBrokerError(err)}`,
          );
        }
      } finally {
        this._consumerStartInFlight = null;
      }
    })();

    this._consumerStartInFlight = promise;
    return promise;
  }

  async onModuleDestroy(): Promise<void> {
    this._destroyed = true;
    await this._closeQuietly();
  }

  private async _ensureConnection(): Promise<ChannelModel> {
    if (this._connection) {
      return this._connection;
    }
    if (this._connectInFlight) {
      return this._connectInFlight;
    }

    const promise = (async () => {
      try {
        const uri = this._configService.get('RABBITMQ_URI', { infer: true });
        const conn = await connect(uri, { timeout: 5_000 });
        conn.on('error', (err) => {
          this._logger.warn(
            `AMQP connection error: ${sanitizeBrokerError(err)}`,
          );
        });
        conn.on('close', () => {
          if (this._connection === conn) {
            this._connection = null;
            this._publishChannel = null;
            this._consumerChannel = null;
          }
        });
        this._connection = conn;
        return conn;
      } finally {
        this._connectInFlight = null;
      }
    })();

    this._connectInFlight = promise;
    return promise;
  }

  private async _ensurePublishChannel(): Promise<ConfirmChannel> {
    if (this._publishChannel) {
      return this._publishChannel;
    }
    const conn = await this._ensureConnection();
    const channel = await conn.createConfirmChannel();
    channel.on('error', (err) => {
      this._logger.warn(
        `AMQP publish channel error: ${sanitizeBrokerError(err)}`,
      );
      if (this._publishChannel === channel) {
        this._publishChannel = null;
      }
    });
    channel.on('close', () => {
      if (this._publishChannel === channel) {
        this._publishChannel = null;
      }
    });
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

    await pub?.close().catch(() => undefined);
    await sub?.close().catch(() => undefined);
    await conn?.close().catch(() => undefined);
  }

  private _destroyed = false;
  private _connection: ChannelModel | null = null;
  private _publishChannel: ConfirmChannel | null = null;
  private _consumerChannel: Channel | null = null;
  private _connectInFlight: Promise<ChannelModel> | null = null;
  private _consumerStartInFlight: Promise<void> | null = null;
  private _lastUnavailableLogAtMs = 0;
  private readonly _logger = new Logger(AmqpBrokerClient.name);
}
