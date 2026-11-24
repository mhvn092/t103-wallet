import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../config/env.validation.js';
import type { DatabaseService } from '../database/database.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  const createHealthService = (pingImpl: () => Promise<void>) => {
    const configService = {
      get: () => 2_000,
    } as unknown as ConfigService<EnvConfig, true>;
    const pingMock = vi.fn(pingImpl);
    const databaseService = {
      ping: pingMock,
    } as unknown as DatabaseService;

    return {
      healthService: new HealthService(configService, databaseService),
      pingMock,
    };
  };

  it('returns liveness status without hitting the database', () => {
    const { healthService, pingMock } = createHealthService(async () => {});
    const result = healthService.getLiveness();

    expect(result.status).toBe('ok');
    expect(typeof result.timestamp).toBe('string');
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('returns ready when PostgreSQL ping succeeds and 503 when ping fails', async () => {
    const okCtx = createHealthService(async () => {});
    const ready = await okCtx.healthService.getReadiness();
    expect(ready.status).toBe('ready');
    expect(ready.database).toBe('ok');

    const failCtx = createHealthService(async () => {
      throw new Error('connection refused');
    });
    await expect(failCtx.healthService.getReadiness()).rejects.toMatchObject({
      status: 503,
    });
  });

  it('returns 503 immediately on readiness checks after beforeApplicationShutdown', async () => {
    const { healthService, pingMock } = createHealthService(async () => {});
    healthService.beforeApplicationShutdown();

    await expect(healthService.getReadiness()).rejects.toMatchObject({
      status: 503,
    });
    expect(pingMock).not.toHaveBeenCalled();
  });
});
