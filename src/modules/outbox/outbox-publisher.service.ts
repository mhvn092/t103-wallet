import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { outboxEvents } from '../../database/schema/index.js';
import { AmqpBrokerClient } from './amqp-broker.client.js';

const CLAIM_LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

@Injectable()
export class OutboxPublisherService {
  constructor(
    private readonly _database: DatabaseService,
    private readonly _broker: AmqpBrokerClient,
  ) {}

  async publishPendingBatch(
    limit = 25,
  ): Promise<{ published: number; failed: number }> {
    const now = new Date();
    const claimed = await this._database.runInTransaction(async (tx) => {
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
          leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS),
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
      await this._broker.publishEvent(
        event.id,
        'balance.changed',
        event.payload,
      );
      await this._database.db
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
        MAX_BACKOFF_MS,
        1000 * 2 ** Math.min(nextRetryCount, 6),
      );
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeError = rawMessage
        .replace(/amqps?:\/\/[^\s]+/gi, '[REDACTED_AMQP_URI]')
        .slice(0, 500);

      this._logger.warn(
        `Outbox publish deferred for event=${event.id} retry=${nextRetryCount}: ${safeError}`,
      );

      await this._database.db
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
