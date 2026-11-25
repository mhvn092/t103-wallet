import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

/**
 * Registers the interactive test console and local simulator proxy.
 * Only mounted when `APP_ENV === 'local'`.
 */
export function registerLocalTestConsole(
  app: NestExpressApplication,
  pspBaseUrl: string,
): void {
  app.enableCors();
  const httpAdapter = app.getHttpAdapter().getInstance();

  httpAdapter.get('/test-console', (_req, res) => {
    res.sendFile(join(process.cwd(), 'public', 'test-console.html'));
  });

  httpAdapter.post('/test-console/sim-pay/:token', async (req, res) => {
    const token = String(req.params.token ?? '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
      res.status(400).json({ error: 'Invalid simulator token format' });
      return;
    }

    try {
      const upstream = await fetch(
        `${pspBaseUrl}/psp/pay/${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body ?? { result: 'success' }),
        },
      );
      const text = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(text);
    } catch (err) {
      res.status(502).json({
        error: 'Failed to reach simulator',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
