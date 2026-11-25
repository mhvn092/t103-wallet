import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const required = {
  DATABASE_URI: 'postgresql://localhost/test',
  RABBITMQ_URI: 'amqp://localhost',
  WEBHOOK_SECRET: 'test-secret',
};

describe('environment validation', () => {
  it('applies defaults, numeric coercion, booleans, and production environment fallback', () => {
    const config = validateEnv({
      ...required,
      NODE_ENV: 'production',
      PORT: '3210',
      SWAGGER_ENABLED: 'true',
      INTERNAL_API_KEY: '  ',
    });
    expect(config.APP_ENV).toBe('production');
    expect(config.PORT).toBe(3210);
    expect(config.SWAGGER_ENABLED).toBe(true);
    expect(config.WORKERS_ENABLED).toBe(true);
    expect(config.INTERNAL_API_KEY).toBeUndefined();
  });

  it.each([
    { PORT: 'not-a-number' },
    { PORT: '65536' },
    { SWAGGER_ENABLED: 'yes' },
    { RECONCILIATION_TZ: 'not-a-timezone' },
    { PSP_BASE_URL: 'ftp://localhost' },
    { WALLET_GATEWAY_KEY: 'short' },
  ])('rejects invalid configuration %o', (invalid) => {
    expect(() => validateEnv({ ...required, ...invalid })).toThrow(
      /Environment validation failed/,
    );
  });
});
