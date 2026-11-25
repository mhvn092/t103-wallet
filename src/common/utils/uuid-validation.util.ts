import { HttpStatus } from '@nestjs/common';
import { validate as isValidUuid } from 'uuid';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode } from '../errors/error-codes.js';

export function assertValidUuid(value: string, fieldName = 'id'): string {
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      `${fieldName} must be a valid UUID`,
    );
  }
  return trimmed;
}
