import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode, type ErrorCodeValue } from '../errors/error-codes.js';

const STATUS_TO_DEFAULT_CODE: Readonly<Record<number, ErrorCodeValue>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.INVALID_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.IDEMPOTENCY_IN_PROGRESS,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.INVALID_REQUEST,
};

function extractMessage(body: string | object, fallback: string): string {
  if (typeof body === 'string') {
    return body;
  }
  const candidate = (body as { message?: string | string[] }).message;
  if (Array.isArray(candidate)) {
    return candidate.join('; ');
  }
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return fallback;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainException) {
      res.status(exception.getStatus()).json({
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const customCode =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { code?: unknown }).code === 'string'
          ? ((body as { code: string }).code as ErrorCodeValue)
          : undefined;
      const code =
        customCode ??
        STATUS_TO_DEFAULT_CODE[status] ??
        (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_REQUEST);

      res.status(status).json({
        code,
        message: extractMessage(body, exception.message),
      });
      return;
    }

    if (
      exception instanceof SyntaxError &&
      'status' in exception &&
      (exception as { status?: number }).status === 400
    ) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: ErrorCode.INVALID_REQUEST,
        message: 'Malformed JSON request body',
      });
      return;
    }

    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  }
}
