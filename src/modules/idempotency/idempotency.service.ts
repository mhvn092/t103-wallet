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

type ExistingRecordOutcome<T> =
  { kind: 'REPLAY'; statusCode: number; body: T } | { kind: 'IN_PROGRESS' };

@Injectable()
export class IdempotencyService {
  constructor(private readonly _database: DatabaseService) {}

  /**
   * Executes a DB-only mutating operation inside a READ COMMITTED transaction whose
   * VERY FIRST statement claims `(scope, key)` in `idempotency_keys`.
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

    return this._database.runInTransaction(async (tx) => {
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
        const outcome = await this._resolveExistingRecord<T>({
          tx,
          scope: params.scope,
          key: params.key,
          requestHash,
          fallbackStatus: targetStatus,
          lockForUpdate: false,
        });
        if (outcome.kind === 'IN_PROGRESS') {
          throw new DomainException(
            HttpStatus.CONFLICT,
            ErrorCode.IDEMPOTENCY_IN_PROGRESS,
            'Request with this Idempotency-Key is currently in progress',
          );
        }
        return {
          replayed: true,
          statusCode: outcome.statusCode,
          body: outcome.body,
        };
      }

      const body = await params.handler(tx);

      await tx
        .update(idempotencyKeys)
        .set({
          status: 'COMPLETED',
          responseStatus: targetStatus,
          responseBody: body,
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
  }): Promise<
    | { kind: 'CLAIMED'; leaseVersion: bigint }
    | { kind: 'REPLAY'; statusCode: number; body: T }
  > {
    const requestHash = sha256CanonicalJson(params.requestBody);
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + (params.leaseMs ?? 60_000));
    const expiresAt = new Date(now.getTime() + DEFAULT_TTL_MS);

    return this._database.runInTransaction(async (tx) => {
      const [inserted] = await tx
        .insert(idempotencyKeys)
        .values({
          scope: params.scope,
          key: params.key,
          requestHash,
          status: 'IN_PROGRESS',
          lockedUntil,
          leaseVersion: 1n,
          expiresAt,
        })
        .onConflictDoNothing({
          target: [idempotencyKeys.scope, idempotencyKeys.key],
        })
        .returning({ leaseVersion: idempotencyKeys.leaseVersion });

      if (inserted) {
        return { kind: 'CLAIMED', leaseVersion: inserted.leaseVersion };
      }

      const outcome = await this._resolveExistingRecord<T>({
        tx,
        scope: params.scope,
        key: params.key,
        requestHash,
        fallbackStatus: HttpStatus.CREATED,
        lockForUpdate: true,
      });
      if (outcome.kind === 'REPLAY') {
        return outcome;
      }

      const reclaimed = await tx
        .update(idempotencyKeys)
        .set({
          lockedUntil,
          leaseVersion: sql`${idempotencyKeys.leaseVersion} + 1`,
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
        .returning({ leaseVersion: idempotencyKeys.leaseVersion });

      const reclaimedRow = reclaimed[0];
      if (!reclaimedRow) {
        throw new DomainException(
          HttpStatus.CONFLICT,
          ErrorCode.IDEMPOTENCY_IN_PROGRESS,
          'Request with this Idempotency-Key is currently in progress',
        );
      }

      return { kind: 'CLAIMED', leaseVersion: reclaimedRow.leaseVersion };
    });
  }

  async completeLeased<T>(params: {
    scope: string;
    key: string;
    leaseVersion: bigint;
    statusCode: number;
    body: T;
    executor?: DbTransaction;
  }): Promise<void> {
    const db = params.executor ?? this._database.db;
    const updated = await db
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus: params.statusCode,
        responseBody: params.body,
        lockedUntil: null,
      })
      .where(
        and(
          eq(idempotencyKeys.scope, params.scope),
          eq(idempotencyKeys.key, params.key),
          eq(idempotencyKeys.status, 'IN_PROGRESS'),
          eq(idempotencyKeys.leaseVersion, params.leaseVersion),
        ),
      )
      .returning({ key: idempotencyKeys.key });

    if (updated.length === 0) {
      throw new DomainException(
        HttpStatus.CONFLICT,
        ErrorCode.IDEMPOTENCY_IN_PROGRESS,
        'Idempotency lease expired or was superseded before completion',
      );
    }
  }

  async releaseLeased(
    scope: string,
    key: string,
    leaseVersion: bigint,
  ): Promise<void> {
    await this._database.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, 'IN_PROGRESS'),
          eq(idempotencyKeys.leaseVersion, leaseVersion),
        ),
      );
  }

  private async _resolveExistingRecord<T>(params: {
    tx: DbTransaction;
    scope: string;
    key: string;
    requestHash: string;
    fallbackStatus: number;
    lockForUpdate: boolean;
  }): Promise<ExistingRecordOutcome<T>> {
    const baseQuery = params.tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, params.scope),
          eq(idempotencyKeys.key, params.key),
        ),
      );

    const [existing] = params.lockForUpdate
      ? await baseQuery.for('update').limit(1)
      : await baseQuery.limit(1);

    if (!existing) {
      throw new DomainException(
        HttpStatus.CONFLICT,
        ErrorCode.IDEMPOTENCY_IN_PROGRESS,
        'Concurrent request in progress for this Idempotency-Key',
      );
    }

    if (existing.requestHash !== params.requestHash) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Idempotency-Key was already used with a different request payload',
      );
    }

    if (existing.status === 'COMPLETED' && existing.responseBody !== null) {
      return {
        kind: 'REPLAY',
        statusCode: existing.responseStatus ?? params.fallbackStatus,
        body: existing.responseBody as T,
      };
    }

    return { kind: 'IN_PROGRESS' };
  }
}
