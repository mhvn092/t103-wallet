import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, lte, or, sql } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { sha256CanonicalJson } from '../../common/utils/canonical-json.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DbTransaction } from '../../database/database.types.js';
import { idempotencyKeys } from '../../database/schema/index.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentExecutionResult<T> {
  replayed: boolean;
  statusCode: number;
  body: T;
}

export type LeasedClaimResult<T> =
  | { kind: 'CLAIMED' }
  | { kind: 'REPLAY'; statusCode: number; body: T };

@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Executes a DB-only mutating operation inside a READ COMMITTED transaction whose
   * VERY FIRST statement claims `(scope, key)` in `idempotency_keys`.
   *
   * PostgreSQL's primary-key index blocks concurrent identical retries until the first
   * transaction commits or rolls back, ensuring:
   * - Concurrent identical retries replay the committed 201 before reading balances.
   * - Business 4xx rejections roll back cleanly uncached so callers can fix & retry.
   */
  async executeInTransaction<T>(params: {
    scope: string;
    key: string;
    requestBody: unknown;
    statusCode?: number;
    handler: (tx: DbTransaction) => Promise<T>;
  }): Promise<IdempotentExecutionResult<T>> {
    const requestHash = sha256CanonicalJson(params.requestBody);
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);
    const targetStatus = params.statusCode ?? HttpStatus.CREATED;

    return this.database.runInTransaction(async (tx) => {
      const [claimed] = await tx
        .insert(idempotencyKeys)
        .values({
          scope: params.scope,
          key: params.key,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt,
        })
        .onConflictDoNothing({
          target: [idempotencyKeys.scope, idempotencyKeys.key],
        })
        .returning();

      if (!claimed) {
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.scope, params.scope),
              eq(idempotencyKeys.key, params.key),
            ),
          )
          .limit(1);

        if (!existing) {
          throw new DomainException(
            HttpStatus.CONFLICT,
            ErrorCode.IDEMPOTENCY_IN_PROGRESS,
            'Concurrent request in progress for this Idempotency-Key',
          );
        }

        if (existing.requestHash !== requestHash) {
          throw new DomainException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'Idempotency-Key was already used with a different request payload',
          );
        }

        if (existing.status !== 'COMPLETED' || existing.responseBody === null) {
          throw new DomainException(
            HttpStatus.CONFLICT,
            ErrorCode.IDEMPOTENCY_IN_PROGRESS,
            'Request with this Idempotency-Key is currently in progress',
          );
        }

        return {
          replayed: true,
          statusCode: existing.responseStatus ?? targetStatus,
          body: existing.responseBody as T,
        };
      }

      const body = await params.handler(tx);

      await tx
        .update(idempotencyKeys)
        .set({
          status: 'COMPLETED',
          responseStatus: targetStatus,
          responseBody: body as unknown,
        })
        .where(
          and(
            eq(idempotencyKeys.scope, params.scope),
            eq(idempotencyKeys.key, params.key),
          ),
        );

      return {
        replayed: false,
        statusCode: targetStatus,
        body,
      };
    });
  }

  /**
   * Claims a leased IN_PROGRESS slot for operations that perform external HTTP calls
   * outside a database transaction (e.g., POST /deposits -> POST /psp/payments).
   */
  async claimLeased<T>(params: {
    scope: string;
    key: string;
    requestBody: unknown;
    leaseMs?: number;
  }): Promise<LeasedClaimResult<T>> {
    const requestHash = sha256CanonicalJson(params.requestBody);
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + (params.leaseMs ?? 60_000));
    const expiresAt = new Date(now.getTime() + DEFAULT_TTL_MS);

    return this.database.runInTransaction(async (tx) => {
      const [inserted] = await tx
        .insert(idempotencyKeys)
        .values({
          scope: params.scope,
          key: params.key,
          requestHash,
          status: 'IN_PROGRESS',
          lockedUntil,
          expiresAt,
        })
        .onConflictDoNothing({
          target: [idempotencyKeys.scope, idempotencyKeys.key],
        })
        .returning();

      if (inserted) {
        return { kind: 'CLAIMED' };
      }

      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, params.scope),
            eq(idempotencyKeys.key, params.key),
          ),
        )
        .for('update')
        .limit(1);

      if (!existing) {
        throw new DomainException(
          HttpStatus.CONFLICT,
          ErrorCode.IDEMPOTENCY_IN_PROGRESS,
          'Concurrent request in progress for this Idempotency-Key',
        );
      }

      if (existing.requestHash !== requestHash) {
        throw new DomainException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          'Idempotency-Key was already used with a different request payload',
        );
      }

      if (existing.status === 'COMPLETED' && existing.responseBody !== null) {
        return {
          kind: 'REPLAY',
          statusCode: existing.responseStatus ?? HttpStatus.CREATED,
          body: existing.responseBody as T,
        };
      }

      // Allow crash recovery once locked_until expires
      const reclaimed = await tx
        .update(idempotencyKeys)
        .set({
          lockedUntil,
        })
        .where(
          and(
            eq(idempotencyKeys.scope, params.scope),
            eq(idempotencyKeys.key, params.key),
            eq(idempotencyKeys.status, 'IN_PROGRESS'),
            or(
              sql`${idempotencyKeys.lockedUntil} IS NULL`,
              lte(idempotencyKeys.lockedUntil, now),
            ),
          ),
        )
        .returning({ key: idempotencyKeys.key });

      if (reclaimed.length === 0) {
        throw new DomainException(
          HttpStatus.CONFLICT,
          ErrorCode.IDEMPOTENCY_IN_PROGRESS,
          'Request with this Idempotency-Key is currently in progress',
        );
      }

      return { kind: 'CLAIMED' };
    });
  }

  async completeLeased<T>(params: {
    scope: string;
    key: string;
    statusCode: number;
    body: T;
    executor?: DbTransaction;
  }): Promise<void> {
    const db = params.executor ?? this.database.db;
    await db
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus: params.statusCode,
        responseBody: params.body as unknown,
        lockedUntil: null,
      })
      .where(
        and(
          eq(idempotencyKeys.scope, params.scope),
          eq(idempotencyKeys.key, params.key),
        ),
      );
  }

  async releaseLeased(scope: string, key: string): Promise<void> {
    await this.database.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, 'IN_PROGRESS'),
        ),
      );
  }
}
