import {
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

export const RequireIdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const raw = req.header('idempotency-key');
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
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
  },
);
