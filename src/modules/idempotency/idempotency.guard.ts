import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isRecord } from '../../common/filters/exception-response.util.js';
import { sha256CanonicalJson } from '../../common/utils/canonical-json.util.js';
import { DatabaseService } from '../../database/database.service.js';
import { idempotencyKeys } from '../../database/schema/operations.schema.js';
import {
  IDEMPOTENCY_REQUEST_CTX,
  IDEMPOTENCY_ROUTE_META,
  type RequestWithIdempotency,
  extractValidatedIdempotencyKey,
} from './idempotency.decorator.js';
import type { IdempotencyRouteConfigInterface } from './idempotency.interface.js';
import { userIdempotencyScope } from './idempotency.util.js';

@Injectable()
export class IdempotencyPreCheckGuard implements CanActivate {
  constructor(
    private readonly _reflector: Reflector,
    private readonly _databaseService: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this._reflector.getAllAndOverride<
      IdempotencyRouteConfigInterface | undefined
    >(IDEMPOTENCY_ROUTE_META, [context.getHandler(), context.getClass()]);
    if (!config) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithIdempotency>();
    const key = extractValidatedIdempotencyKey(req.header('idempotency-key'));

    const rawBody: unknown = req.body ?? {};
    const userValue =
      config.userField && isRecord(rawBody)
        ? rawBody[config.userField]
        : undefined;
    const userId = typeof userValue === 'string' ? userValue.trim() : '';
    const scope =
      config.userField && userId
        ? userIdempotencyScope(config.scope, userId)
        : config.scope;
    const hashBody =
      config.excludeUserFromHash && config.userField && isRecord(rawBody)
        ? Object.fromEntries(
            Object.entries(rawBody).filter(
              ([name]) => name !== config.userField,
            ),
          )
        : rawBody;
    const hashPayload = config.includeParam
      ? {
          [config.includeParam]: req.params?.[config.includeParam] ?? null,
          body: hashBody,
        }
      : hashBody;
    const requestHash = sha256CanonicalJson(hashPayload);

    req[IDEMPOTENCY_REQUEST_CTX] = {
      key,
      scope,
      requestHash,
    };

    if (config.userField && !userId) {
      return true;
    }

    const [existing] = await this._databaseService.db
      .select({ requestHash: idempotencyKeys.requestHash })
      .from(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)),
      )
      .limit(1);

    if (existing && existing.requestHash !== requestHash) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Idempotency-Key was already used with a different request payload',
      );
    }

    return true;
  }
}
