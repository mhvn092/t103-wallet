import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { InternalOpsGuard } from './internal-ops.guard.js';

function createContext(opts: { key?: string; ip?: string }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip: opts.ip ?? '127.0.0.1',
        header: (name: string) =>
          name.toLowerCase() === 'x-internal-api-key' ? opts.key : undefined,
      }),
    }),
  } as never;
}

function makeConfig(overrides: Partial<Record<keyof EnvConfig, string | undefined>>) {
  return {
    get: (key: keyof EnvConfig) => overrides[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

describe('InternalOpsGuard', () => {
  it('allows requests when INTERNAL_API_KEY and INTERNAL_ALLOWED_IPS are unset', () => {
    const guard = new InternalOpsGuard(makeConfig({}));
    expect(guard.canActivate(createContext({}))).toBe(true);
  });

  it('enforces timing-safe X-Internal-Api-Key when configured', () => {
    const guard = new InternalOpsGuard(
      makeConfig({ INTERNAL_API_KEY: 'super-secret-ops-key' }),
    );
    expect(() => guard.canActivate(createContext({}))).toThrow();
    expect(() =>
      guard.canActivate(createContext({ key: 'short' })),
    ).toThrow();
    expect(() =>
      guard.canActivate(createContext({ key: 'super-secret-ops-kez' })),
    ).toThrow();
    expect(
      guard.canActivate(createContext({ key: 'super-secret-ops-key' })),
    ).toBe(true);
  });

  it('enforces IP allowlist including ::ffff: IPv4-mapped addresses when configured', () => {
    const guard = new InternalOpsGuard(
      makeConfig({ INTERNAL_ALLOWED_IPS: '10.0.0.5, 127.0.0.1' }),
    );
    expect(
      guard.canActivate(createContext({ ip: '::ffff:10.0.0.5' })),
    ).toBe(true);
    expect(() =>
      guard.canActivate(createContext({ ip: '192.168.1.99' })),
    ).toThrow();
  });
});
