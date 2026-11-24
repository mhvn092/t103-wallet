import { HttpStatus } from '@nestjs/common';
import { ErrorCode, type ErrorCodeValue } from '../errors/error-codes.js';

const VALID_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

export const STATUS_TO_DEFAULT_CODE: Readonly<Record<number, ErrorCodeValue>> =
  {
    [HttpStatus.BAD_REQUEST]: ErrorCode.INVALID_REQUEST,
    [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
    [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
    [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
    [HttpStatus.CONFLICT]: ErrorCode.IDEMPOTENCY_IN_PROGRESS,
    [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.INVALID_REQUEST,
  };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toErrorCode(value: unknown): ErrorCodeValue | undefined {
  if (typeof value === 'string' && VALID_ERROR_CODES.has(value)) {
    return Object.values(ErrorCode).find((code) => code === value);
  }
  return undefined;
}

export function extractExceptionMessage(
  body: string | object,
  fallback: string,
): string {
  if (typeof body === 'string') {
    return body;
  }
  if (isRecord(body) && 'message' in body) {
    const candidate = body.message;
    if (Array.isArray(candidate)) {
      return candidate.filter((item) => typeof item === 'string').join('; ');
    }
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return fallback;
}
