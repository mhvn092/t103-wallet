import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCodeValue } from './error-codes.js';

export class DomainException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCodeValue,
    message: string,
  ) {
    super({ code, message }, status);
  }
}
