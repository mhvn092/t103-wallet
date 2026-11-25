import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

const STATUS_DESCRIPTIONS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request / Validation Error',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized / Invalid Credentials or Signature',
  [HttpStatus.FORBIDDEN]:
    'Forbidden / Outbound Operations Frozen or Restricted',
  [HttpStatus.NOT_FOUND]: 'Resource Not Found',
  [HttpStatus.CONFLICT]:
    'Conflict / Invalid State Transition or In-Progress Idempotency',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Business Rule Violation',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service or External Provider Unavailable',
};

export const AUTHENTICATED_WRITE_ERROR_STATUSES = [
  HttpStatus.BAD_REQUEST,
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.CONFLICT,
  HttpStatus.UNPROCESSABLE_ENTITY,
] as const;

export function ApiErrorResponses(...statuses: number[]): MethodDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: STATUS_DESCRIPTIONS[status] ?? 'Error response',
        type: ErrorResponseDto,
      }),
    ),
  );
}
