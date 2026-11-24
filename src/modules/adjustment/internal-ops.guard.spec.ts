import { randomBytes } from 'node:crypto';
import { faker } from '@faker-js/faker';
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

function makeConfig(
  overrides: Partial<Record<keyof EnvConfig, string | undefined>>,
) {
  return {
    get: (key: keyof EnvConfig) =>
      overrides[key] ?? (key === 'APP_ENV' ? 'local' : undefined),
  } as unknown as ConfigService<EnvConfig, true>;
}

describe('InternalOpsGuard', () => {
  it('allows requests in local env when INTERNAL_API_KEY and INTERNAL_ALLOWED_IPS are unset', () => {
    const guard = new InternalOpsGuard(makeConfig({ APP_ENV: 'local' }));
    expect(guard.canActivate(createContext({}))).toBe(true);
  });

  it('fails closed in production when INTERNAL_API_KEY is unset even if IP allowlist is set', () => {
    const guardNoConfig = new InternalOpsGuard(
      makeConfig({ APP_ENV: 'production' }),
    );
    expect(() => guardNoConfig.canActivate(createContext({}))).toThrow(
      /production/,
    );

    const guardIpOnly = new InternalOpsGuard(
      makeConfig({ APP_ENV: 'production', INTERNAL_ALLOWED_IPS: '127.0.0.1' }),
    );
    expect(() => guardIpOnly.canActivate(createContext({}))).toThrow(
      /INTERNAL_API_KEY/,
    );
  });

  it('enforces timing-safe X-Internal-Api-Key when configured', () => {
    const generatedKey = randomBytes(16).toString('hex');
    const tamperedKey = `${generatedKey.slice(0, -1)}${generatedKey.endsWith('0') ? '1' : '0'}`;
    const guard = new InternalOpsGuard(
      makeConfig({ APP_ENV: 'production', INTERNAL_API_KEY: generatedKey }),
    );
    expect(() => guard.canActivate(createContext({}))).toThrow();
    expect(() => guard.canActivate(createContext({ key: 'short' }))).toThrow();
    expect(() =>
      guard.canActivate(createContext({ key: tamperedKey })),
    ).toThrow();
    expect(guard.canActivate(createContext({ key: generatedKey }))).toBe(true);
  });

  it('enforces IP allowlist including ::ffff: IPv4-mapped addresses when configured', () => {
    const allowedIp = faker.internet.ipv4();
    const deniedIp = faker.internet.ipv4();
    const guard = new InternalOpsGuard(
      makeConfig({ INTERNAL_ALLOWED_IPS: `${allowedIp}, 127.0.0.1` }),
    );
    expect(
      guard.canActivate(createContext({ ip: `::ffff:${allowedIp}` })),
    ).toBe(true);
    expect(() => guard.canActivate(createContext({ ip: deniedIp }))).toThrow();
  });
});
