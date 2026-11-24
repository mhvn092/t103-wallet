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

const VALID_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

const STATUS_TO_DEFAULT_CODE: Readonly<Record<number, ErrorCodeValue>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.INVALID_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.IDEMPOTENCY_IN_PROGRESS,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.INVALID_REQUEST,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorCode(value: unknown): ErrorCodeValue | undefined {
  if (typeof value === 'string' && VALID_ERROR_CODES.has(value)) {
    return Object.values(ErrorCode).find((code) => code === value);
  }
  return undefined;
}

function extractMessage(body: string | object, fallback: string): string {
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

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
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
      this._handleHttpException(exception, res);
      return;
    }

    if (
      exception instanceof SyntaxError &&
      'status' in exception &&
      exception.status === 400
    ) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: ErrorCode.INVALID_REQUEST,
        message: 'Malformed JSON request body',
      });
      return;
    }

    this._logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  }

  private _handleHttpException(exception: HttpException, res: Response): void {
    const status = exception.getStatus();
    const body = exception.getResponse();
    const customCode = isRecord(body) ? toErrorCode(body.code) : undefined;
    const defaultCode =
      STATUS_TO_DEFAULT_CODE[status] ??
      (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_REQUEST);

    res.status(status).json({
      code: customCode ?? defaultCode,
      message: extractMessage(body, exception.message),
    });
  }

  private readonly _logger = new Logger(AllExceptionsFilter.name);
}
