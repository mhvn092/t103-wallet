import {
  HttpStatus,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  resolveCorrelationId,
  runWithRequestContext,
} from './common/context/request-context.js';
import { DomainException } from './common/errors/domain.exception.js';
import { ErrorCode } from './common/errors/error-codes.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

function flattenValidationErrors(errors: ValidationError[]): string {
  return errors
    .flatMap((err) => {
      const own = err.constraints ? Object.values(err.constraints) : [];
      const children = err.children?.length
        ? [flattenValidationErrors(err.children)]
        : [];
      return [...own, ...children];
    })
    .filter((msg) => msg.length > 0)
    .join('; ');
}

export function configureApp(app: INestApplication): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveCorrelationId(req.header('x-request-id'));
    res.setHeader('x-request-id', requestId);
    runWithRequestContext(requestId, () => {
      next();
    });
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const message = flattenValidationErrors(errors) || 'Validation failed';
        return new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          message,
        );
      },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
}
