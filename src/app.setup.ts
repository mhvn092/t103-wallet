import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  resolveCorrelationId,
  runWithRequestContext,
} from './common/context/request-context.util.js';
import { DomainException } from './common/errors/domain.exception.js';
import { ErrorCode } from './common/errors/error-codes.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { flattenValidationErrors } from './common/utils/validation-error.util.js';

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
      exceptionFactory: (errors) => {
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
