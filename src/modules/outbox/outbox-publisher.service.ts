import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { outboxEvents } from '../../database/schema/index.js';
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
    const now = new Date();
    const claimed = await this._databaseService.runInTransaction(async (tx) => {
      const due = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.status, 'PENDING'),
            lte(outboxEvents.nextRetryAt, now),
            or(
              isNull(outboxEvents.leaseUntil),
              lte(outboxEvents.leaseUntil, now),
            ),
          ),
        )
        .orderBy(asc(outboxEvents.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (due.length === 0) {
        return [];
      }

      await tx
        .update(outboxEvents)
        .set({
          leaseUntil: new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS),
        })
        .where(
          inArray(
            outboxEvents.id,
            due.map((row) => row.id),
          ),
        );

      return due;
    });

    let published = 0;
    let failed = 0;

    for (const event of claimed) {
      const ok = await this._deliverSingleEvent(event);
      if (ok) {
        published += 1;
      } else {
        failed += 1;
      }
    }

    return { published, failed };
  }

  private async _deliverSingleEvent(
    event: typeof outboxEvents.$inferSelect,
  ): Promise<boolean> {
    try {
      await this._amqpBrokerClient.publishEvent(
        event.id,
        BALANCE_CHANGED_ROUTING_KEY,
        event.payload,
      );
      await this._databaseService.db
        .update(outboxEvents)
        .set({
          status: 'PUBLISHED',
          publishedAt: new Date(),
          leaseUntil: null,
          lastError: null,
        })
        .where(eq(outboxEvents.id, event.id));
      return true;
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

      await this._databaseService.db
        .update(outboxEvents)
        .set({
          retryCount: nextRetryCount,
          lastError: safeError,
          nextRetryAt: new Date(Date.now() + backoffMs),
          leaseUntil: null,
        })
        .where(eq(outboxEvents.id, event.id));
      return false;
    }
  }

  private readonly _logger = new Logger(OutboxPublisherService.name);
}
