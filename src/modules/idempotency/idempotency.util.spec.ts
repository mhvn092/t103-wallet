import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainException } from '../../common/errors/domain.exception.js';
import {
  isCacheableRequestError,
  userIdempotencyScope,
} from './idempotency.util.js';

describe('idempotency utilities', () => {
  it('scopes keys by route and user', () => {
    expect(userIdempotencyScope('POST:/transfers', 'user-1')).toBe(
      'POST:/transfers:user-1',
    );
  });

  it('caches only client validation domain errors', () => {
    expect(
      isCacheableRequestError(
        new DomainException(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'bad'),
      ),
    ).toBe(true);
    expect(
      isCacheableRequestError(
        new DomainException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'INVALID_REQUEST',
          'bad',
        ),
      ),
    ).toBe(true);
    expect(
      isCacheableRequestError(
        new DomainException(HttpStatus.CONFLICT, 'INVALID_REQUEST', 'conflict'),
      ),
    ).toBe(false);
    expect(isCacheableRequestError(new Error('bad'))).toBe(false);
  });
});
