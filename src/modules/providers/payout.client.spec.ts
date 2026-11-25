import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_AMOUNT_MINOR } from '../../common/utils/money.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { PayoutClient } from './payout.client.js';
import { parseIrrToIrt } from './provider-http.util.js';

describe('Payout create response classification', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [{ reason: 'DUPLICATE_REQUEST_ID' }, 'AMBIGUOUS'],
    [{ message: 'Upstream validation error' }, 'AMBIGUOUS'],
    [{ reason: 'INVALID_IBAN' }, 'PERMANENT_REJECTED'],
  ])('classifies provider HTTP 422 with %o as %s', async (body, kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json(body, { status: 422 })),
    );
    const client = new PayoutClient(
      new ConfigService<EnvConfig, true>({
        PAYOUT_BASE_URL: 'https://payout.example',
        PROVIDER_HTTP_TIMEOUT_MS: 1_000,
      }),
    );
    const outcome = await client.createTransfer({
      requestId: 'wd_test',
      currency: 'IRT',
      destination: 'IR062960000000100324200001',
      amountMinor: 150_000n,
    });
    expect(outcome.kind).toBe(kind);
  });
});

describe('Provider IRR amounts', () => {
  it('accepts whole decimal Rials and preserves sub-Toman remainder', () => {
    expect(parseIrrToIrt('1500000.00')).toEqual({
      amountIrt: 150_000n,
      hasRemainder: false,
    });
    expect(parseIrrToIrt('1500001.00')).toEqual({
      amountIrt: 150_000n,
      hasRemainder: true,
    });
  });

  it('rejects fractional Rials, lossy JSON numbers, and over-limit amounts', () => {
    expect(parseIrrToIrt('1500000.01')).toBeNull();
    expect(parseIrrToIrt(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(
      parseIrrToIrt(((MAX_AMOUNT_MINOR + 1n) * 10n).toString()),
    ).toBeNull();
  });
});
