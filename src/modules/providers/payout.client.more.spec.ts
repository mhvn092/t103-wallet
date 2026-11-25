import { describe, expect, it, vi, afterEach } from 'vitest';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import { PayoutClient } from './payout.client.js';

function client() {
  const config = {
    get: (key: string) =>
      ({
        PAYOUT_BASE_URL: 'https://payout.invalid',
        PROVIDER_HTTP_TIMEOUT_MS: 1000,
      })[key],
  };
  return new PayoutClient(config as never);
}

function response(status: number, body: unknown) {
  return vi
    .fn()
    .mockResolvedValue({ status, text: async () => JSON.stringify(body) });
}

describe('PayoutClient outcomes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts either provider tracking identifier and falls back to the request id', async () => {
    const payout = client();
    vi.stubGlobal('fetch', response(200, { trackingId: 'track-1' }));
    await expect(
      payout.createTransfer({
        requestId: 'r1',
        currency: CurrencyEnum.IRT,
        amountMinor: 100n,
        destination: 'IR',
      }),
    ).resolves.toEqual({ kind: 'ACCEPTED', trackingId: 'track-1' });
    vi.stubGlobal('fetch', response(202, { id: 'id-2' }));
    await expect(
      payout.createTransfer({
        requestId: 'r2',
        currency: CurrencyEnum.USDT,
        amountMinor: 1_000_000n,
        destination: 'T',
      }),
    ).resolves.toEqual({ kind: 'ACCEPTED', trackingId: 'id-2' });
    vi.stubGlobal('fetch', response(200, {}));
    await expect(
      payout.createTransfer({
        requestId: 'r3',
        currency: CurrencyEnum.IRT,
        amountMinor: 1n,
        destination: 'IR',
      }),
    ).resolves.toEqual({ kind: 'ACCEPTED', trackingId: 'r3' });
  });

  it('distinguishes definitive rejection from ambiguous provider failures', async () => {
    const payout = client();
    vi.stubGlobal('fetch', response(422, { reason: 'INVALID_IBAN' }));
    await expect(
      payout.createTransfer({
        requestId: 'r',
        currency: CurrencyEnum.IRT,
        amountMinor: 10n,
        destination: 'bad',
      }),
    ).resolves.toEqual({ kind: 'PERMANENT_REJECTED', reason: 'INVALID_IBAN' });
    vi.stubGlobal('fetch', response(422, { reason: 'TEMPORARY' }));
    await expect(
      payout.createTransfer({
        requestId: 'r',
        currency: CurrencyEnum.IRT,
        amountMinor: 10n,
        destination: 'bad',
      }),
    ).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'Payout createTransfer returned HTTP 422',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      payout.createTransfer({
        requestId: 'r',
        currency: CurrencyEnum.IRT,
        amountMinor: 10n,
        destination: 'bad',
      }),
    ).resolves.toEqual({ kind: 'AMBIGUOUS', reason: 'offline' });
  });

  it('handles inquiry not-found, invalid status, malformed body, and provider fields', async () => {
    const payout = client();
    vi.stubGlobal('fetch', response(404, {}));
    await expect(payout.getTransfer('a/b')).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('a%2Fb'),
      expect.any(Object),
    );
    vi.stubGlobal('fetch', response(503, {}));
    await expect(payout.getTransfer('r')).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'Payout inquiry returned HTTP 503',
    });
    vi.stubGlobal('fetch', response(200, {}));
    await expect(payout.getTransfer('r')).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: expect.stringContaining('schema'),
    });
    vi.stubGlobal(
      'fetch',
      response(200, {
        status: 'SUCCEEDED',
        trackingId: 't',
        failureReason: 'why',
        amount: 2,
        currency: 'USDT',
      }),
    );
    await expect(payout.getTransfer('r')).resolves.toEqual({
      kind: 'FOUND',
      status: 'SUCCEEDED',
      providerRefId: 't',
      failureReason: 'why',
      amount: 2,
      currency: 'USDT',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(payout.getTransfer('r')).resolves.toEqual({
      kind: 'AMBIGUOUS',
      reason: 'offline',
    });
  });
});
