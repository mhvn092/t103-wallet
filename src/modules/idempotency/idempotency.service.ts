import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, gt, lte, or, sql } from 'drizzle-orm';
import { IdempotencyStatus } from '../../common/enums/domain.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { sha256CanonicalJson } from '../../common/utils/canonical-json.util.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DbTransaction } from '../../database/database.types.js';
import { idempotencyKeys } from '../../database/schema/index.js';
import {
  IDEMPOTENCY_DEFAULT_LEASE_MS,
  IDEMPOTENCY_DEFAULT_TTL_MS,
} from './idempotency.constants.js';
import type {
  ExistingRecordOutcome,
  IdempotentExecutionResult,
} from './idempotency.types.js';

import { isCacheableRequestError } from './idempotency.util.js';

@Injectable()
export class IdempotencyService {
  constructor(private readonly _databaseService: DatabaseService) {}

  /**
   * Executes a DB-only mutating operation inside a READ COMMITTED transaction whose
   * VERY FIRST statement claims `(scope, key)` in `idempotency_keys`.
   */
  async executeInTransaction<T>(params: {
    scope: string;
    key: string;
    requestBody: unknown;
    requestHashOverride?: string;
    statusCode?: number;
    handler: (tx: DbTransaction) => Promise<T>;
  }): Promise<IdempotentExecutionResult<T>> {
    const requestHash =
      params.requestHashOverride ?? sha256CanonicalJson(params.requestBody);
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_DEFAULT_TTL_MS);
    const targetStatus = params.statusCode ?? HttpStatus.CREATED;

    const result = await this._databaseService.runInTransaction(async (tx) => {
      const [claimed] = await tx
        .insert(idempotencyKeys)
        .values({
          scope: params.scope,
          key: params.key,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
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

      // Roll back business mutations on rejection while retaining the original key claim.
      const response = await tx
        .transaction(params.handler)
        .then((body) => ({ statusCode: targetStatus, body }))
        .catch((error: unknown) => {
          if (!isCacheableRequestError(error)) {
            throw error;
          }
          return { statusCode: error.getStatus(), body: error.getResponse() };
        });

      await tx
        .update(idempotencyKeys)
        .set({
          status: IdempotencyStatus.COMPLETED,
          responseStatus: response.statusCode,
          responseBody: response.body,
        })
        .where(
          and(
            eq(idempotencyKeys.scope, params.scope),
            eq(idempotencyKeys.key, params.key),
          ),
        );

      return {
        replayed: false,
        statusCode: response.statusCode,
        body: response.body as T,
      };
    });

    if (result.statusCode >= HttpStatus.BAD_REQUEST) {
      throw new HttpException(result.body as object, result.statusCode);
    }
    return result;
  }

  /**
   * Claims a leased IN_PROGRESS slot for operations that perform external HTTP calls
   * outside a database transaction (e.g., POST /deposits -> POST /psp/payments).
   */
  async claimLeased<T>(params: {
    scope: string;
    key: string;
    requestBody: unknown;
    requestHashOverride?: string;
    leaseMs?: number;
  }): Promise<
    | { kind: 'CLAIMED'; leaseVersion: bigint }
    | { kind: 'REPLAY'; statusCode: number; body: T }
  > {
    const requestHash =
      params.requestHashOverride ?? sha256CanonicalJson(params.requestBody);
    const leaseMs = params.leaseMs ?? IDEMPOTENCY_DEFAULT_LEASE_MS;
    const lockedUntilExpr = sql<Date>`NOW() + (${leaseMs} * INTERVAL '1 millisecond')`;
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_DEFAULT_TTL_MS);

    return this._databaseService.runInTransaction(async (tx) => {
      const [inserted] = await tx
        .insert(idempotencyKeys)
        .values({
          scope: params.scope,
          key: params.key,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          lockedUntil: lockedUntilExpr,
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
          lockedUntil: lockedUntilExpr,
          leaseVersion: sql`${idempotencyKeys.leaseVersion} + 1`,
        })
        .where(
          and(
            eq(idempotencyKeys.scope, params.scope),
            eq(idempotencyKeys.key, params.key),
            eq(idempotencyKeys.status, IdempotencyStatus.IN_PROGRESS),
            or(
              sql`${idempotencyKeys.lockedUntil} IS NULL`,
              lte(idempotencyKeys.lockedUntil, sql`NOW()`),
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
    const db = params.executor ?? this._databaseService.db;
    const updated = await db
      .update(idempotencyKeys)
      .set({
        status: IdempotencyStatus.COMPLETED,
        responseStatus: params.statusCode,
        responseBody: params.body,
        lockedUntil: null,
      })
      .where(
        and(
          eq(idempotencyKeys.scope, params.scope),
          eq(idempotencyKeys.key, params.key),
          eq(idempotencyKeys.status, IdempotencyStatus.IN_PROGRESS),
          eq(idempotencyKeys.leaseVersion, params.leaseVersion),
          gt(idempotencyKeys.lockedUntil, sql`NOW()`),
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
    await this._databaseService.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, IdempotencyStatus.IN_PROGRESS),
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

    if (
      existing.status === IdempotencyStatus.COMPLETED &&
      existing.responseBody !== null
    ) {
      return {
        kind: 'REPLAY',
        statusCode: existing.responseStatus ?? params.fallbackStatus,
        body: existing.responseBody as T,
      };
    }

    return { kind: 'IN_PROGRESS' };
  }
}
