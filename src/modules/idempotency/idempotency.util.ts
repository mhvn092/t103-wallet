import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception.js';

export function userIdempotencyScope(route: string, userId: string): string {
  return `${route}:${userId}`;
}

export function isCacheableRequestError(
  error: unknown,
): error is DomainException {
  return (
    error instanceof DomainException &&
    (error.getStatus() === HttpStatus.BAD_REQUEST ||
      error.getStatus() === HttpStatus.UNPROCESSABLE_ENTITY)
  );
}
