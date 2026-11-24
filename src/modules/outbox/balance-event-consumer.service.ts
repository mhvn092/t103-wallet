import { Injectable } from '@nestjs/common';
import { assertValidUuid } from '../../common/utils/uuid-validation.js';
import { DatabaseService } from '../../database/database.service.js';
import { processedEvents } from '../../database/schema/index.js';

@Injectable()
export class BalanceEventConsumerService {
  constructor(private readonly _database: DatabaseService) {}

  async processEvent(params: {
    eventId: string;
    consumerName: string;
    payload: unknown;
  }): Promise<{ applied: boolean }> {
    const validEventId = assertValidUuid(params.eventId, 'eventId');
    if (params.payload === undefined) {
      return { applied: false };
    }

    return this._database.runInTransaction(async (tx) => {
      const inserted = await tx
        .insert(processedEvents)
        .values({
          eventId: validEventId,
          consumerName: params.consumerName,
        })
        .onConflictDoNothing({
          target: [processedEvents.eventId, processedEvents.consumerName],
        })
        .returning({ eventId: processedEvents.eventId });

      return { applied: inserted.length > 0 };
    });
  }
}
