import {
  SetMetadata,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type {
  IdempotencyRequestContext,
  IdempotencyRouteConfig,
} from './idempotency.types.js';

export const IDEMPOTENCY_ROUTE_META = Symbol('IDEMPOTENCY_ROUTE_META');
export const IDEMPOTENCY_REQUEST_CTX = Symbol('IDEMPOTENCY_REQUEST_CTX');

export type RequestWithIdempotency = Request & {
  [IDEMPOTENCY_REQUEST_CTX]?: IdempotencyRequestContext;
};

export function IdempotentRoute(
  scope: string,
  options?: Omit<IdempotencyRouteConfig, 'scope'>,
): MethodDecorator {
  const config: IdempotencyRouteConfig = {
    scope,
    ...options,
  };
  return SetMetadata(IDEMPOTENCY_ROUTE_META, config);
}

export function extractValidatedIdempotencyKey(
  rawHeader: string | undefined,
): string {
  const trimmed = typeof rawHeader === 'string' ? rawHeader.trim() : '';
  if (!trimmed) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.MISSING_IDEMPOTENCY_KEY,
      'Idempotency-Key header is required',
    );
  }
  if (trimmed.length > 255) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      'Idempotency-Key must be at most 255 characters',
    );
  }
  return trimmed;
}

export const RequireIdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<RequestWithIdempotency>();
    const prevalidated = req[IDEMPOTENCY_REQUEST_CTX]?.key;
    if (prevalidated) {
      return prevalidated;
    }
    return extractValidatedIdempotencyKey(req.header('idempotency-key'));
  },
);

export const IdempotencyRequestHash = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithIdempotency>();
    return req[IDEMPOTENCY_REQUEST_CTX]?.requestHash;
  },
);
