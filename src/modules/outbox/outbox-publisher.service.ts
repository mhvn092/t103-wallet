import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { OutboxStatusEnum } from '../../common/enums/outbox.enums.js';
import { DatabaseService } from '../../database/database.service.js';
import { outboxEvents } from '../../database/schema/operations.schema.js';
import { AmqpBrokerClient } from './amqp-broker.client.js';
import { sanitizeBrokerError } from './amqp-error.util.js';
import {
  BALANCE_CHANGED_ROUTING_KEY,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_BACKOFF_MS,
} from './outbox.constants.js';

@Injectable()
export class OutboxPublisherService {
  constructor(
    private readonly _databaseService: DatabaseService,
    private readonly _amqpBrokerClient: AmqpBrokerClient,
  ) {}

  async publishPendingBatch(
    limit = 25,
  ): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;

    for (let index = 0; index < limit; index += 1) {
      const event = await this._claimNextEvent();
      if (!event) {
        break;
      }
      const outcome = await this._deliverSingleEvent(event);
      if (outcome === 'PUBLISHED') {
        published += 1;
      } else if (outcome === 'DEFERRED') {
        failed += 1;
      }
    }

    return { published, failed };
  }

  private async _claimNextEvent() {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS);
    return this._databaseService.runInTransaction(async (tx) => {
      const [due] = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.status, OutboxStatusEnum.PENDING),
            lte(outboxEvents.nextRetryAt, now),
            or(
              isNull(outboxEvents.leaseUntil),
              lte(outboxEvents.leaseUntil, now),
            ),
          ),
        )
        .orderBy(asc(outboxEvents.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!due) {
        return undefined;
      }
      await tx
        .update(outboxEvents)
        .set({ leaseUntil })
        .where(eq(outboxEvents.id, due.id));
      return { ...due, leaseUntil };
    });
  }

  private async _deliverSingleEvent(
    event: typeof outboxEvents.$inferSelect & { leaseUntil: Date },
  ): Promise<'PUBLISHED' | 'DEFERRED' | 'SUPERSEDED'> {
    const owned = and(
      eq(outboxEvents.id, event.id),
      eq(outboxEvents.status, OutboxStatusEnum.PENDING),
      eq(outboxEvents.leaseUntil, event.leaseUntil),
    );
    try {
      await this._amqpBrokerClient.publishEvent(
        event.id,
        BALANCE_CHANGED_ROUTING_KEY,
        event.payload,
      );
      const [saved] = await this._databaseService.db
        .update(outboxEvents)
        .set({
          status: OutboxStatusEnum.PUBLISHED,
          publishedAt: new Date(),
          leaseUntil: null,
          lastError: null,
        })
        .where(owned)
        .returning({ id: outboxEvents.id });
      return saved ? 'PUBLISHED' : 'SUPERSEDED';
    } catch (err) {
      const nextRetryCount = event.retryCount + 1;
      const backoffMs = Math.min(
        OUTBOX_MAX_BACKOFF_MS,
        1000 * 2 ** Math.min(nextRetryCount, 6),
      );
      const safeError = sanitizeBrokerError(err).slice(0, 500);

      this._logger.warn(
        `Outbox publish deferred for event=${event.id} retry=${nextRetryCount}: ${safeError}`,
      );

      const [saved] = await this._databaseService.db
        .update(outboxEvents)
        .set({
          retryCount: nextRetryCount,
          lastError: safeError,
          nextRetryAt: new Date(Date.now() + backoffMs),
          leaseUntil: null,
        })
        .where(owned)
        .returning({ id: outboxEvents.id });
      return saved ? 'DEFERRED' : 'SUPERSEDED';
    }
  }

  private readonly _logger = new Logger(OutboxPublisherService.name);
}
