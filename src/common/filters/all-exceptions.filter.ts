import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { getCorrelationId } from '../context/request-context.util.js';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import {
  extractExceptionMessage,
  isRecord,
  STATUS_TO_DEFAULT_CODE,
  toErrorCode,
} from './exception-response.util.js';

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

    const correlationId = getCorrelationId();
    this._logger.error(
      correlationId
        ? `Unhandled exception [requestId=${correlationId}]`
        : 'Unhandled exception',
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
      message: extractExceptionMessage(body, exception.message),
    });
  }

  private readonly _logger = new Logger(AllExceptionsFilter.name);
}
