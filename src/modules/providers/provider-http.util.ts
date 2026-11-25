import type { ConfigService } from '@nestjs/config';
import { getCorrelationId } from '../../common/context/request-context.util.js';
import { MAX_AMOUNT_MINOR } from '../../common/utils/money.util.js';
import type { EnvConfig } from '../../config/env.validation.js';

type HttpJsonOutcome =
  | { kind: 'RESPONSE'; status: number; data: unknown }
  | { kind: 'NETWORK_ERROR'; reason: string };

const SAFE_MAX_IRR = BigInt(Number.MAX_SAFE_INTEGER);
const WHOLE_IRR_REGEX = /^\d+(?:\.0+)?$/;
const MAX_IRR_DIGITS = (MAX_AMOUNT_MINOR * 10n).toString().length;

async function fetchJsonWithTimeout(params: {
  url: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  timeoutMs: number;
}): Promise<HttpJsonOutcome> {
  try {
    const headers: Record<string, string> = {};
    if (params.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const correlationId = getCorrelationId();
    if (correlationId) {
      headers['x-request-id'] = correlationId;
    }

    const res = await fetch(params.url, {
      method: params.method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      signal: AbortSignal.timeout(params.timeoutMs),
    });

    const text = await res.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawText: text };
      }
    }

    return { kind: 'RESPONSE', status: res.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'NETWORK_ERROR', reason: message };
  }
}

export async function requestProviderJson(params: {
  config: ConfigService<EnvConfig, true>;
  baseUrlKey: 'PSP_BASE_URL' | 'PAYOUT_BASE_URL';
  path: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
}): Promise<HttpJsonOutcome> {
  const baseUrl = params.config.get(params.baseUrlKey, { infer: true });
  const timeoutMs = params.config.get('PROVIDER_HTTP_TIMEOUT_MS', {
    infer: true,
  });

  return fetchJsonWithTimeout({
    url: `${baseUrl}${params.path}`,
    method: params.method,
    body: params.body,
    timeoutMs,
  });
}

export function toSafeIrrPayloadAmount(amountIrr: bigint): number | string {
  return amountIrr <= SAFE_MAX_IRR ? Number(amountIrr) : amountIrr.toString();
}

export function parseIrrToIrt(
  rawAmount: unknown,
): { amountIrt: bigint; hasRemainder: boolean } | null {
  let irrMinor: bigint | null = null;

  if (typeof rawAmount === 'number') {
    if (Number.isSafeInteger(rawAmount) && rawAmount >= 0) {
      irrMinor = BigInt(rawAmount);
    }
  } else if (typeof rawAmount === 'string') {
    const trimmed = rawAmount.trim();
    if (WHOLE_IRR_REGEX.test(trimmed)) {
      const whole = trimmed.split('.', 1)[0]?.replace(/^0+/, '') ?? '';
      if (whole.length <= MAX_IRR_DIGITS) {
        irrMinor = BigInt(whole);
      }
    }
  }

  if (irrMinor === null || irrMinor / 10n > MAX_AMOUNT_MINOR) {
    return null;
  }

  return {
    amountIrt: irrMinor / 10n,
    hasRemainder: irrMinor % 10n !== 0n,
  };
}
