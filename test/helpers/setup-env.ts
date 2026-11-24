import { prepareTestEnv } from './test-env.js';

if (process.env.LIVE_SIMULATOR_E2E === 'true') {
  const port = process.env.HOSTILE_TEST_APP_PORT ?? '3999';
  process.env.APP_PUBLIC_URL ??= `http://host.docker.internal:${port}`;
  process.env.WORKERS_ENABLED ??= 'true';
  process.env.WORKER_POLL_INTERVAL_MS ??= '400';
  process.env.WD_MANUAL_REVIEW_SLA_MS ??= '12000';
}

prepareTestEnv();
