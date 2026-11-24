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
  overrides: Partial<{
    APP_ENV: EnvConfig['APP_ENV'];
    NODE_ENV: EnvConfig['NODE_ENV'];
    ALLOW_UNAUTHENTICATED_INTERNAL_OPS: boolean;
    INTERNAL_API_KEY: string;
    INTERNAL_ALLOWED_IPS: string;
  }>,
) {
  return {
    get: (key: keyof EnvConfig) => {
      if (key in overrides) {
        return overrides[key as keyof typeof overrides];
      }
      if (key === 'APP_ENV') {
        return 'local';
      }
      if (key === 'NODE_ENV') {
        return 'development';
      }
      if (key === 'ALLOW_UNAUTHENTICATED_INTERNAL_OPS') {
        return false;
      }
      return undefined;
    },
  } as unknown as ConfigService<EnvConfig, true>;
}

describe('InternalOpsGuard', () => {
  it('allows requests in local dev env when INTERNAL_API_KEY and INTERNAL_ALLOWED_IPS are unset', () => {
    const guard = new InternalOpsGuard(
      makeConfig({ APP_ENV: 'local', NODE_ENV: 'development' }),
    );
    expect(guard.canActivate(createContext({}))).toBe(true);
  });

  it('fails closed when NODE_ENV=production and APP_ENV=local unless ALLOW_UNAUTHENTICATED_INTERNAL_OPS=true (F-11)', () => {
    const guardBlocked = new InternalOpsGuard(
      makeConfig({
        APP_ENV: 'local',
        NODE_ENV: 'production',
        ALLOW_UNAUTHENTICATED_INTERNAL_OPS: false,
      }),
    );
    expect(() => guardBlocked.canActivate(createContext({}))).toThrow(
      /INTERNAL_API_KEY/,
    );

    const guardComposeOptIn = new InternalOpsGuard(
      makeConfig({
        APP_ENV: 'local',
        NODE_ENV: 'production',
        ALLOW_UNAUTHENTICATED_INTERNAL_OPS: true,
      }),
    );
    expect(guardComposeOptIn.canActivate(createContext({}))).toBe(true);

    const guardRealProd = new InternalOpsGuard(
      makeConfig({
        APP_ENV: 'production',
        NODE_ENV: 'production',
        ALLOW_UNAUTHENTICATED_INTERNAL_OPS: true,
      }),
    );
    expect(() => guardRealProd.canActivate(createContext({}))).toThrow(
      /INTERNAL_API_KEY/,
    );
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
