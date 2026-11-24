import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode } from '../errors/error-codes.js';

const UUID_REGEX = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function assertValidUuid(value: string, fieldName = 'id'): string {
  const trimmed = value.trim();
  if (!UUID_REGEX.test(trimmed)) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      `${fieldName} must be a valid UUID`,
    );
  }
  return trimmed;
}
