import { HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DomainException } from '../errors/domain.exception.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { ErrorCode } from '../errors/error-codes.js';

describe('AllExceptionsFilter', () => {
  const createHost = () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    };
    return { host: host as never, status, json };
  };

  it('formats DomainException into {code, message}', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost();

    filter.catch(
      new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.INSUFFICIENT_FUNDS,
        'Available balance is too low',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      code: 'INSUFFICIENT_FUNDS',
      message: 'Available balance is too low',
    });
  });

  it('maps generic HttpException to {code, message}', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost();

    filter.catch(new NotFoundException('Route not found'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      code: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  it('masks unknown errors as 500 INTERNAL_ERROR without leaking details', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost();

    filter.catch(new Error('secret db connection string leaked'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
