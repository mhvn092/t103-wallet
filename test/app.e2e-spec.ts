import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
} from './helpers/test-env.js';

describe('App Bootstrap & Error Contract (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    prepareTestEnv();
    getRequiredTestDatabaseUri();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health and /health/liveness return 200 ok without leaking environment details', async () => {
    const legacy = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(legacy.body).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
    });

    const k8s = await request(app.getHttpServer())
      .get('/health/liveness')
      .expect(200);
    expect(k8s.body).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
    });
  });

  it('returns Appendix A {code, message} shape on unknown route', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);
    expect(res.body).toEqual({
      code: 'NOT_FOUND',
      message: expect.any(String),
    });
  });
});
