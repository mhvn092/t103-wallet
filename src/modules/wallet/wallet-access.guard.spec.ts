import { describe, expect, it, vi } from 'vitest';
import { WalletAccessGuard } from './wallet-access.guard.js';

function context(
  headers: Record<string, string>,
  body: unknown = {},
  params: Record<string, string> = {},
) {
  const req = {
    body,
    params,
    header: (name: string) => headers[name.toLowerCase()],
  };
  return {
    req,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
    },
  };
}

describe('WalletAccessGuard', () => {
  it('allows local requests when gateway authentication is not configured', () => {
    const config = {
      get: (key: string) => (key === 'APP_ENV' ? 'local' : undefined),
    };
    const guard = new WalletAccessGuard(
      config as never,
      { get: vi.fn() } as never,
    );
    expect(guard.canActivate(context({}).ctx as never)).toBe(true);
  });

  it('rejects missing configuration, invalid credentials, and user mismatch', () => {
    const missing = new WalletAccessGuard(
      { get: () => undefined } as never,
      { get: vi.fn() } as never,
    );
    expect(() => missing.canActivate(context({}).ctx as never)).toThrow(
      /not configured/,
    );
    const config = { get: () => 'gateway-secret' };
    const reflector = {
      get: vi.fn().mockReturnValue({ userField: 'fromUserId' }),
    };
    const guard = new WalletAccessGuard(config as never, reflector as never);
    expect(() => guard.canActivate(context({}).ctx as never)).toThrow(
      /credentials/,
    );
    expect(() =>
      guard.canActivate(
        context(
          {
            'x-wallet-gateway-key': 'gateway-secret',
            'x-wallet-user-id': 'u1',
          },
          { fromUserId: 'u2' },
        ).ctx as never,
      ),
    ).toThrow(/does not match/);
    expect(() =>
      guard.canActivate(
        context({
          'x-wallet-gateway-key': 'gateway-secret',
          'x-wallet-user-id': 'u'.repeat(129),
        }).ctx as never,
      ),
    ).toThrow(/credentials/);
  });

  it('authenticates a matching owner and stores the principal on the request', () => {
    const guard = new WalletAccessGuard(
      { get: () => 'gateway-secret' } as never,
      { get: vi.fn().mockReturnValue({ userField: 'fromUserId' }) } as never,
    );
    const { ctx, req } = context(
      {
        'x-wallet-gateway-key': 'gateway-secret',
        'x-wallet-user-id': ' u1 ',
      },
      { fromUserId: 'u1' },
    );
    expect(guard.canActivate(ctx as never)).toBe(true);
    expect(Object.getOwnPropertySymbols(req).length).toBe(1);
  });
});
