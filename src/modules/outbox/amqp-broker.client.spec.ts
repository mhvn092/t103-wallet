import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { connect } from 'amqplib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { AmqpBrokerClient } from './amqp-broker.client.js';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

describe('AMQP publisher confirmation deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('times out even when the broker never confirms or closes, then reconnects', async () => {
    vi.useFakeTimers();
    const channel = Object.assign(new EventEmitter(), {
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
      bindQueue: vi.fn(),
      publish: vi.fn(),
      waitForConfirms: vi
        .fn()
        .mockResolvedValue(undefined)
        .mockImplementationOnce(() => new Promise(() => {})),
    });
    const close = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(connect).mockResolvedValue(
      Object.assign(new EventEmitter(), {
        createConfirmChannel: vi.fn().mockResolvedValue(channel),
        close,
      }) as unknown as Awaited<ReturnType<typeof connect>>,
    );
    const broker = new AmqpBrokerClient(
      new ConfigService<EnvConfig, true>({
        RABBITMQ_URI: 'amqp://localhost',
      }),
    );
    const failed = expect(
      broker.publishEvent('unconfirmed', 'balance.changed', {}),
    ).rejects.toThrow('AMQP publish confirmation timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(close).toHaveBeenCalledTimes(1);
    await broker.publishEvent('retry', 'balance.changed', {});
    expect(connect).toHaveBeenCalledTimes(2);
    await broker.onModuleDestroy();
  });
});
