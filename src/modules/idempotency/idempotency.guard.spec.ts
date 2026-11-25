import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { sha256CanonicalJson } from '../../common/utils/canonical-json.util.js';
import type { DatabaseService } from '../../database/database.service.js';
import {
  IDEMPOTENCY_REQUEST_CTX,
  type RequestWithIdempotency,
} from './idempotency.decorator.js';
import { IdempotencyPreCheckGuard } from './idempotency.guard.js';
import type { IdempotencyRouteConfigInterface } from './idempotency.interface.js';

function makeContext(opts: {
  key?: string;
  body?: unknown;
  params?: Record<string, string>;
}): { context: ExecutionContext; req: RequestWithIdempotency } {
  const req = {
    body: opts.body,
    params: opts.params ?? {},
    header: (name: string) =>
      name.toLowerCase() === 'idempotency-key' ? opts.key : undefined,
  } as unknown as RequestWithIdempotency;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class Dummy {},
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;

  return { context, req };
}

function makeGuard(
  routeConfig: IdempotencyRouteConfigInterface | undefined,
  existingHash?: string,
): IdempotencyPreCheckGuard {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(routeConfig),
  } as unknown as Reflector;

  const limitFn = vi
    .fn()
    .mockResolvedValue(
      existingHash !== undefined ? [{ requestHash: existingHash }] : [],
    );
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const databaseService = {
    db: { select: selectFn },
  } as unknown as DatabaseService;

  return new IdempotencyPreCheckGuard(reflector, databaseService);
}

describe('IdempotencyPreCheckGuard (F-06)', () => {
  it('passes through routes without @IdempotentRoute metadata', async () => {
    const guard = makeGuard(undefined);
    const { context } = makeContext({});
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects missing or >255-char Idempotency-Key with 400', async () => {
    const guard = makeGuard({ scope: 'POST:/withdrawals' });
    await expect(
      guard.canActivate(makeContext({ body: {} }).context),
    ).rejects.toThrow(/Idempotency-Key header is required/);

    await expect(
      guard.canActivate(
        makeContext({ key: 'x'.repeat(256), body: {} }).context,
      ),
    ).rejects.toThrow(/at most 255/);
  });

  it('populates request context for new keys and exact replays', async () => {
    const payload = { userId: 'alice', amount: '100000' };
    const hash = sha256CanonicalJson(payload);
    const guard = makeGuard({ scope: 'POST:/withdrawals' }, hash);
    const { context, req } = makeContext({ key: 'k-1', body: payload });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req[IDEMPOTENCY_REQUEST_CTX]).toEqual({
      key: 'k-1',
      scope: 'POST:/withdrawals',
      requestHash: hash,
    });
  });

  it('throws 422 IDEMPOTENCY_KEY_REUSED before DTO ValidationPipe on invalid, extra-field, or different-user payloads', async () => {
    const originalHash = sha256CanonicalJson({
      userId: 'alice',
      currency: 'IRT',
      amount: '100000',
    });
    const guard = makeGuard({ scope: 'POST:/withdrawals' }, originalHash);

    await expect(
      guard.canActivate(
        makeContext({
          key: 'k-1',
          body: { userId: 'bob', currency: 'IRT', amount: '100000' },
        }).context,
      ),
    ).rejects.toThrow(/different request payload/);

    await expect(
      guard.canActivate(
        makeContext({
          key: 'k-1',
          body: {
            userId: 'alice',
            currency: 'BTC',
            amount: 123,
            extraField: true,
          },
        }).context,
      ),
    ).rejects.toThrow(/different request payload/);
  });

  it('includes route parameter when includeParam is configured', async () => {
    const hashForId1 = sha256CanonicalJson({ id: 'wd-1', body: {} });
    const guard = makeGuard(
      { scope: 'POST:/withdrawals/:id/cancel', includeParam: 'id' },
      hashForId1,
    );

    await expect(
      guard.canActivate(
        makeContext({ key: 'k-cancel', params: { id: 'wd-1' }, body: {} })
          .context,
      ),
    ).resolves.toBe(true);

    await expect(
      guard.canActivate(
        makeContext({ key: 'k-cancel', params: { id: 'wd-2' }, body: {} })
          .context,
      ),
    ).rejects.toThrow(/different request payload/);
  });
});
