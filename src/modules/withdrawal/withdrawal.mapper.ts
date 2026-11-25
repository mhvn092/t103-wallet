import type { ConfigService } from '@nestjs/config';
import { Currency } from '../../common/enums/domain.enums.js';
import {
  convertUsdtToIrtCeiling,
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { parseIrrToIrt } from '../providers/provider-http.util.js';
import type { WithdrawalResponseDto } from './dto/withdrawal-response.dto.js';
import type {
  WithdrawalEntity,
  WithdrawalPolicyAmounts,
} from './withdrawal.types.js';

export function computeWithdrawalPolicyAmounts(
  configService: ConfigService<EnvConfig, true>,
  amountMinor: bigint,
  currency: Currency,
): WithdrawalPolicyAmounts {
  const dailyLimitIrt = parseAmountToMinor(
    configService.get('DAILY_LIMIT_IRT', { infer: true }),
    Currency.IRT,
  );
  if (currency === Currency.IRT) {
    return {
      feeMinor: 0n,
      fxRateIrt: 1n,
      irtEquivalent: amountMinor,
      dailyLimitIrt,
    };
  }

  const feeMinor = parseAmountToMinor(
    configService.get('USDT_WITHDRAWAL_FEE', { infer: true }),
    Currency.USDT,
    { allowZero: true },
  );
  const fxRateIrt = parseAmountToMinor(
    configService.get('USDT_IRT_RATE', { infer: true }),
    Currency.IRT,
  );
  return {
    feeMinor,
    fxRateIrt,
    irtEquivalent: convertUsdtToIrtCeiling(amountMinor, fxRateIrt),
    dailyLimitIrt,
  };
}

export function isWebhookAmountValid(
  expectedCurrency: Currency,
  expectedMinor: bigint,
  providedAmount: string | number,
  providedCurrency?: string | null,
): boolean {
  const normCcy = providedCurrency?.trim().toUpperCase();
  try {
    if (expectedCurrency === Currency.IRT) {
      if (normCcy === Currency.IRT) {
        return (
          parseAmountToMinor(String(providedAmount), Currency.IRT) ===
          expectedMinor
        );
      }
      const parsedIrr = parseIrrToIrt(providedAmount);
      return (
        parsedIrr !== null &&
        !parsedIrr.hasRemainder &&
        parsedIrr.amountIrt === expectedMinor
      );
    }
    return (
      parseAmountToMinor(String(providedAmount), Currency.USDT) ===
      expectedMinor
    );
  } catch {
    return false;
  }
}

export function toWithdrawalResponseDto(
  row: WithdrawalEntity,
): WithdrawalResponseDto {
  return {
    withdrawalId: row.id,
    userId: row.userId,
    currency: row.currency,
    amount: formatMinorToApi(BigInt(row.amount), row.currency),
    fee: formatMinorToApi(BigInt(row.fee), row.currency),
    status: row.status,
    destination: row.destination,
    providerRequestId: row.providerRequestId,
    providerRefId: row.providerRefId,
    failureReason: row.failureReason,
    lateSuccessConflict: row.lateSuccessConflict,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
