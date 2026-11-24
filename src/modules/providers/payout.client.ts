import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { type Currency, formatMinorToApi } from '../../common/utils/money.js';
import type { EnvConfig } from '../../config/env.validation.js';
import {
  requestProviderJson,
  toSafeIrrPayloadAmount,
} from './provider-http.util.js';
import type {
  PayoutCreateResult,
  PayoutTransferStatusResult,
} from './provider.types.js';

const payoutAcceptedSchema = z.object({
  trackingId: z.string().nullish(),
  id: z.string().nullish(),
});

const payoutErrorSchema = z.object({
  reason: z.string().nullish(),
  message: z.string().nullish(),
});

const payoutInquirySchema = z.object({
  status: z.enum([
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'RETURNED',
    'REVERSED',
  ]),
  trackingId: z.string().nullish(),
  refId: z.string().nullish(),
  reason: z.string().nullish(),
  failureReason: z.string().nullish(),
});

@Injectable()
export class PayoutClient {
  constructor(private readonly _config: ConfigService<EnvConfig, true>) {}

  async createTransfer(params: {
    requestId: string;
    currency: Currency;
    amountMinor: bigint;
    destination: string;
  }): Promise<PayoutCreateResult> {
    const payloadAmount =
      params.currency === 'IRT'
        ? toSafeIrrPayloadAmount(params.amountMinor * 10n)
        : formatMinorToApi(params.amountMinor, 'USDT');

    const outcome = await requestProviderJson({
      config: this._config,
      baseUrlKey: 'PAYOUT_BASE_URL',
      path: '/payout/transfers',
      method: 'POST',
      body: {
        requestId: params.requestId,
        type: params.currency === 'IRT' ? 'IBAN' : 'CRYPTO',
        destination: params.destination,
        amount: payloadAmount,
        currency: params.currency === 'IRT' ? 'IRR' : 'USDT',
      },
    });

    if (outcome.kind === 'NETWORK_ERROR') {
      return { kind: 'AMBIGUOUS', reason: outcome.reason };
    }

    if (outcome.status === 200 || outcome.status === 202) {
      const parsed = payoutAcceptedSchema.safeParse(outcome.data);
      const trackingId = parsed.success
        ? (parsed.data.trackingId ?? parsed.data.id ?? params.requestId)
        : params.requestId;
      return { kind: 'ACCEPTED', trackingId };
    }

    if (outcome.status === 400 || outcome.status === 422) {
      const parsedErr = payoutErrorSchema.safeParse(outcome.data);
      const reason = parsedErr.success
        ? (parsedErr.data.reason ??
          parsedErr.data.message ??
          `Rejected with HTTP ${outcome.status}`)
        : `Rejected with HTTP ${outcome.status}`;
      return { kind: 'PERMANENT_REJECTED', reason };
    }

    return {
      kind: 'AMBIGUOUS',
      reason: `Payout createTransfer returned HTTP ${outcome.status}`,
    };
  }

  async getTransfer(requestId: string): Promise<PayoutTransferStatusResult> {
    const outcome = await requestProviderJson({
      config: this._config,
      baseUrlKey: 'PAYOUT_BASE_URL',
      path: `/payout/transfers/${encodeURIComponent(requestId)}`,
      method: 'GET',
    });

    if (outcome.kind === 'NETWORK_ERROR') {
      return { kind: 'AMBIGUOUS', reason: outcome.reason };
    }

    if (outcome.status === 404) {
      return { kind: 'NOT_FOUND' };
    }

    if (
      outcome.status >= 500 ||
      outcome.status < 200 ||
      outcome.status >= 300
    ) {
      return {
        kind: 'AMBIGUOUS',
        reason: `Payout inquiry returned HTTP ${outcome.status}`,
      };
    }

    const parsed = payoutInquirySchema.safeParse(outcome.data);
    if (!parsed.success) {
      return {
        kind: 'AMBIGUOUS',
        reason: 'Payout inquiry returned unexpected JSON schema',
      };
    }

    return {
      kind: 'FOUND',
      status: parsed.data.status,
      providerRefId: parsed.data.refId ?? parsed.data.trackingId ?? null,
      failureReason: parsed.data.reason ?? parsed.data.failureReason ?? null,
    };
  }
}
