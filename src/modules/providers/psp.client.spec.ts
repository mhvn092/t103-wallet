import { afterEach, describe, expect, it, vi } from 'vitest';
import { PspClient } from './psp.client.js';

function client() {
  return new PspClient({
    get: (key: string) =>
      ({
        PSP_BASE_URL: 'https://psp.invalid',
        PROVIDER_HTTP_TIMEOUT_MS: 1000,
        DEPOSIT_TTL_SECONDS: 300,
      })[key],
  } as never);
}
function json(status: number, data: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(data),
  });
}

describe('PspClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates payments with provider expiry or a configured fallback', async () => {
    const psp = client();
    vi.stubGlobal(
      'fetch',
      json(201, {
        token: 'tok',
        paymentUrl: 'https://pay.invalid',
        expiresAt: '2025-01-01T00:00:00Z',
      }),
    );
    await expect(
      psp.createPayment({
        amountIrt: 100n,
        orderId: 'order',
        callbackUrl: 'https://cb.invalid',
      }),
    ).resolves.toEqual({
      token: 'tok',
      paymentUrl: 'https://pay.invalid',
      expiresAt: new Date('2025-01-01T00:00:00Z'),
    });
    vi.stubGlobal(
      'fetch',
      json(200, {
        token: 'tok2',
        paymentUrl: 'https://pay.invalid',
        expiresAt: 'invalid',
      }),
    );
    const before = Date.now();
    const fallback = await psp.createPayment({
      amountIrt: 100n,
      orderId: 'order',
      callbackUrl: 'https://cb.invalid',
    });
    expect(fallback.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 299_000,
    );
    vi.stubGlobal('fetch', json(200, {}));
    await expect(
      psp.createPayment({
        amountIrt: 100n,
        orderId: 'order',
        callbackUrl: 'x',
      }),
    ).rejects.toThrow(/invalid payload/);
    vi.stubGlobal('fetch', json(503, {}));
    await expect(
      psp.createPayment({
        amountIrt: 100n,
        orderId: 'order',
        callbackUrl: 'x',
      }),
    ).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      psp.createPayment({
        amountIrt: 100n,
        orderId: 'order',
        callbackUrl: 'x',
      }),
    ).rejects.toThrow(/offline/);
  });

  it('parses payment status, preserves ambiguous outcomes, and accepts absent optional amount', async () => {
    const psp = client();
    vi.stubGlobal(
      'fetch',
      json(200, {
        status: 'PAID',
        amount: '1000',
        refId: 'ref',
        orderId: 'ord',
      }),
    );
    await expect(psp.getPaymentStatus('a/b')).resolves.toEqual({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 100n,
      refId: 'ref',
      orderId: 'ord',
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('a%2Fb'),
      expect.any(Object),
    );
    vi.stubGlobal('fetch', json(200, { status: 'PAID', amount: 1001 }));
    await expect(psp.getPaymentStatus('t')).resolves.toMatchObject({
      kind: 'FOUND',
      amountIrt: 100n,
    });
    vi.stubGlobal('fetch', json(200, { status: 'PAID' }));
    await expect(psp.getPaymentStatus('t')).resolves.toMatchObject({
      kind: 'FOUND',
      amountIrt: null,
    });
    vi.stubGlobal('fetch', json(200, {}));
    await expect(psp.getPaymentStatus('t')).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: expect.stringContaining('schema'),
    });
    vi.stubGlobal('fetch', json(503, {}));
    await expect(psp.getPaymentStatus('t')).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'PSP status inquiry returned HTTP 503',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(psp.getPaymentStatus('t')).resolves.toEqual({
      kind: 'AMBIGUOUS',
      reason: 'offline',
    });
  });

  it('classifies verification results and settlement report failures', async () => {
    const psp = client();
    vi.stubGlobal('fetch', json(200, { code: 100, amount: 1000, refId: 'r' }));
    await expect(psp.verifyPayment('t')).resolves.toEqual({
      kind: 'VERIFIED',
      amountIrt: 100n,
      refId: 'r',
      hasIrrRemainder: false,
    });
    vi.stubGlobal('fetch', json(200, { status: 'OK', amount: 1001 }));
    await expect(psp.verifyPayment('t')).resolves.toMatchObject({
      kind: 'VERIFIED',
      amountIrt: 100n,
      hasIrrRemainder: true,
    });
    vi.stubGlobal('fetch', json(200, { code: 101, amount: 0 }));
    await expect(psp.verifyPayment('t')).resolves.toEqual({
      kind: 'INVALID_VERIFIED_AMOUNT',
      reportedAmount: '0',
    });
    vi.stubGlobal('fetch', json(200, { code: -51, message: 'declined' }));
    await expect(psp.verifyPayment('t')).resolves.toEqual({
      kind: 'FAILED',
      reason: 'declined',
    });
    vi.stubGlobal('fetch', json(200, { status: 'FAILED' }));
    await expect(psp.verifyPayment('t')).resolves.toMatchObject({
      kind: 'FAILED',
    });
    vi.stubGlobal('fetch', json(503, {}));
    await expect(psp.verifyPayment('t')).resolves.toMatchObject({
      kind: 'RETRYABLE_ERROR',
      reason: 'PSP verify returned HTTP 503',
    });
    vi.stubGlobal('fetch', json(200, { code: 'bad' }));
    await expect(psp.verifyPayment('t')).resolves.toMatchObject({
      kind: 'RETRYABLE_ERROR',
      reason: expect.stringContaining('unparseable'),
    });
    vi.stubGlobal('fetch', json(200, { code: 0, message: 'try later' }));
    await expect(psp.verifyPayment('t')).resolves.toEqual({
      kind: 'RETRYABLE_ERROR',
      reason: 'try later',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(psp.verifyPayment('t')).resolves.toEqual({
      kind: 'RETRYABLE_ERROR',
      reason: 'offline',
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: async () => 'csv' }),
    );
    await expect(psp.fetchSettlementCsv('2025-01-01')).resolves.toBe('csv');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    await expect(psp.fetchSettlementCsv('2025-01-01')).rejects.toThrow(
      /HTTP 503/,
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(psp.fetchSettlementCsv('2025-01-01')).rejects.toThrow(
      /offline/,
    );
  });
});
