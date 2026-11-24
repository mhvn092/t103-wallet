import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { EnvConfig } from '../../config/env.validation.js';
import {
  parseIrrToIrt,
  requestProviderJson,
  toSafeIrrPayloadAmount,
} from './provider-http.util.js';
import type {
  PspPaymentStatusResult,
  PspVerifyResult,
} from './provider.types.js';
import {
  pspCreatePaymentResponseSchema,
  pspPaymentStatusSchema,
  pspVerifyResponseSchema,
} from './psp.schemas.js';

@Injectable()
export class PspClient {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
  ) {}

  async createPayment(params: {
    amountIrt: bigint;
    orderId: string;
    callbackUrl: string;
  }): Promise<{ token: string; paymentUrl: string; expiresAt: Date }> {
    const ttlSeconds = this._configService.get('DEPOSIT_TTL_SECONDS', {
      infer: true,
    });
    const amountIrr = params.amountIrt * 10n;
    const outcome = await requestProviderJson({
      config: this._configService,
      baseUrlKey: 'PSP_BASE_URL',
      path: '/psp/payments',
      method: 'POST',
      body: {
        amount: toSafeIrrPayloadAmount(amountIrr),
        orderId: params.orderId,
        callbackUrl: params.callbackUrl,
      },
    });

    if (outcome.kind === 'NETWORK_ERROR') {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        `PSP createPayment failed: ${outcome.reason}`,
      );
    }

    if (outcome.status < 200 || outcome.status >= 300) {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        `PSP createPayment returned HTTP ${outcome.status}`,
      );
    }

    const parsed = pspCreatePaymentResponseSchema.safeParse(outcome.data);
    if (!parsed.success) {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        'PSP createPayment returned invalid payload',
      );
    }

    const fallbackExpiry = new Date(Date.now() + ttlSeconds * 1000);
    const rawExpires = parsed.data.expiresAt
      ? new Date(parsed.data.expiresAt)
      : fallbackExpiry;
    const expiresAt = Number.isNaN(rawExpires.getTime())
      ? fallbackExpiry
      : rawExpires;

    return {
      token: parsed.data.token,
      paymentUrl: parsed.data.paymentUrl,
      expiresAt,
    };
  }

  async getPaymentStatus(token: string): Promise<PspPaymentStatusResult> {
    const outcome = await requestProviderJson({
      config: this._configService,
      baseUrlKey: 'PSP_BASE_URL',
      path: `/psp/payments/${encodeURIComponent(token)}`,
      method: 'GET',
    });

    if (outcome.kind === 'NETWORK_ERROR') {
      return { kind: 'AMBIGUOUS', reason: outcome.reason };
    }

    if (outcome.status < 200 || outcome.status >= 300) {
      return {
        kind: 'AMBIGUOUS',
        reason: `PSP status inquiry returned HTTP ${outcome.status}`,
      };
    }

    const parsed = pspPaymentStatusSchema.safeParse(outcome.data);
    if (!parsed.success) {
      return {
        kind: 'AMBIGUOUS',
        reason: 'PSP status inquiry returned unexpected JSON schema',
      };
    }

    const converted =
      parsed.data.amount !== undefined && parsed.data.amount !== null
        ? parseIrrToIrt(parsed.data.amount)
        : null;
    if (converted?.hasRemainder) {
      this._logger.warn(
        `PSP reported non-multiple-of-10 IRR amount for token=${token}`,
      );
    }

    return {
      kind: 'FOUND',
      status: parsed.data.status,
      amountIrt: converted ? converted.amountIrt : null,
      refId: parsed.data.refId ?? null,
      orderId: parsed.data.orderId ?? null,
    };
  }

  async verifyPayment(token: string): Promise<PspVerifyResult> {
    const outcome = await requestProviderJson({
      config: this._configService,
      baseUrlKey: 'PSP_BASE_URL',
      path: '/psp/verify',
      method: 'POST',
      body: { token },
    });

    if (outcome.kind === 'NETWORK_ERROR') {
      return { kind: 'RETRYABLE_ERROR', reason: outcome.reason };
    }

    if (outcome.status >= 500) {
      return {
        kind: 'RETRYABLE_ERROR',
        reason: `PSP verify returned HTTP ${outcome.status}`,
      };
    }

    const parsed = pspVerifyResponseSchema.safeParse(outcome.data);
    if (!parsed.success) {
      return {
        kind: 'RETRYABLE_ERROR',
        reason: 'PSP verify returned unparseable JSON',
      };
    }

    const { code, status, amount, refId, message } = parsed.data;
    const isVerified =
      code === 100 ||
      code === 101 ||
      status === 'OK' ||
      status === 'ALREADY_VERIFIED';

    if (isVerified) {
      const converted =
        amount !== undefined && amount !== null ? parseIrrToIrt(amount) : null;
      if (!converted || converted.amountIrt <= 0n) {
        return {
          kind: 'RETRYABLE_ERROR',
          reason: 'PSP verify succeeded without positive IRR amount',
        };
      }
      return {
        kind: 'VERIFIED',
        amountIrt: converted.amountIrt,
        refId: refId ?? null,
        hasIrrRemainder: converted.hasRemainder,
      };
    }

    if (code === -51 || status === 'FAILED') {
      return {
        kind: 'FAILED',
        reason: message ?? 'PSP payment verification returned FAILED',
      };
    }

    return {
      kind: 'RETRYABLE_ERROR',
      reason:
        message ?? `Unexpected PSP verify response HTTP ${outcome.status}`,
    };
  }

  async fetchSettlementCsv(date: string): Promise<string> {
    const baseUrl = this._configService.get('PSP_BASE_URL', { infer: true });
    const timeoutMs = this._configService.get('PROVIDER_HTTP_TIMEOUT_MS', {
      infer: true,
    });

    try {
      const res = await fetch(
        `${baseUrl}/psp/settlement?date=${encodeURIComponent(date)}`,
        {
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!res.ok) {
        throw new DomainException(
          HttpStatus.SERVICE_UNAVAILABLE,
          ErrorCode.PROVIDER_UNAVAILABLE,
          `PSP settlement report returned HTTP ${res.status}`,
        );
      }
      return await res.text();
    } catch (err) {
      if (err instanceof DomainException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        `PSP settlement report request failed: ${message}`,
      );
    }
  }

  private readonly _logger = new Logger(PspClient.name);
}
