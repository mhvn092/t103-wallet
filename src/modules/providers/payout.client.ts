import { parseValidated } from '../../common/utils/parse-validated.util.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import {
  PayoutCurrencyEnum,
  PayoutTransferTypeEnum,
} from '../../common/enums/provider.enums.js';
import { formatMinorToApi } from '../../common/utils/money.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import {
  PayoutAcceptedDto,
  PayoutErrorDto,
  PayoutInquiryDto,
} from './payout.schemas.js';
import {
  requestProviderJson,
  toSafeIrrPayloadAmount,
} from './provider-http.util.js';
import type {
  PayoutCreateResult,
  PayoutTransferStatusResult,
} from './provider.types.js';

const DEFINITIVE_VALIDATION_ERRORS = new Set([
  'INVALID_IBAN',
  'INVALID_DESTINATION',
  'INVALID_REQUEST_ID',
  'BELOW_MINIMUM',
]);

@Injectable()
export class PayoutClient {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
  ) {}

  async createTransfer(params: {
    requestId: string;
    currency: CurrencyEnum;
    amountMinor: bigint;
    destination: string;
  }): Promise<PayoutCreateResult> {
    const payloadAmount =
      params.currency === CurrencyEnum.IRT
        ? toSafeIrrPayloadAmount(params.amountMinor * 10n)
        : formatMinorToApi(params.amountMinor, CurrencyEnum.USDT);

    const outcome = await requestProviderJson({
      config: this._configService,
      baseUrlKey: 'PAYOUT_BASE_URL',
      path: '/payout/transfers',
      method: 'POST',
      body: {
        requestId: params.requestId,
        type:
          params.currency === CurrencyEnum.IRT
            ? PayoutTransferTypeEnum.IBAN
            : PayoutTransferTypeEnum.CRYPTO,
        destination: params.destination,
        amount: payloadAmount,
        currency:
          params.currency === CurrencyEnum.IRT
            ? PayoutCurrencyEnum.IRR
            : PayoutCurrencyEnum.USDT,
      },
    });

    if (outcome.kind === 'NETWORK_ERROR') {
      return { kind: 'AMBIGUOUS', reason: outcome.reason };
    }

    if (outcome.status === 200 || outcome.status === 202) {
      const parsed = parseValidated(PayoutAcceptedDto, outcome.data);
      const trackingId = parsed.success
        ? (parsed.data.trackingId ?? parsed.data.id ?? params.requestId)
        : params.requestId;
      return { kind: 'ACCEPTED', trackingId };
    }

    if (outcome.status === 400 || outcome.status === 422) {
      const parsedErr = parseValidated(PayoutErrorDto, outcome.data);
      const reason = parsedErr.success
        ? (parsedErr.data.reason ?? parsedErr.data.error)
        : null;
      if (reason && DEFINITIVE_VALIDATION_ERRORS.has(reason)) {
        return { kind: 'PERMANENT_REJECTED', reason };
      }
    }

    return {
      kind: 'AMBIGUOUS',
      reason: `Payout createTransfer returned HTTP ${outcome.status}`,
    };
  }

  async getTransfer(requestId: string): Promise<PayoutTransferStatusResult> {
    const outcome = await requestProviderJson({
      config: this._configService,
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

    if (outcome.status < 200 || outcome.status >= 300) {
      return {
        kind: 'AMBIGUOUS',
        reason: `Payout inquiry returned HTTP ${outcome.status}`,
      };
    }

    const parsed = parseValidated(PayoutInquiryDto, outcome.data);
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
      amount: parsed.data.amount ?? null,
      currency: parsed.data.currency ?? null,
    };
  }
}
