import { prepareTestEnv } from './test-env.js';

prepareTestEnv();

if (process.env.LIVE_SIMULATOR_E2E === 'true') {
  const port = process.env.HOSTILE_TEST_APP_PORT ?? '3999';
  process.env.APP_PUBLIC_URL ??= `http://host.docker.internal:${port}`;
  process.env.WD_MANUAL_REVIEW_SLA_MS ??= '8000';
}
