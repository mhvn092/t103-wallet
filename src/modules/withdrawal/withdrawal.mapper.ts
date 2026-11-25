import type { WithdrawalPolicyAmountsInterface } from './withdrawal.interface.js';
import type { ConfigService } from '@nestjs/config';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import {
  convertUsdtToIrtCeiling,
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { parseIrrToIrt } from '../providers/provider-http.util.js';
import type { WithdrawalResponseDto } from './dto/withdrawal-response.dto.js';
import type { WithdrawalEntity } from './withdrawal.types.js';

export function computeWithdrawalPolicyAmounts(
  configService: ConfigService<EnvConfig, true>,
  amountMinor: bigint,
  currency: CurrencyEnum,
): WithdrawalPolicyAmountsInterface {
  const dailyLimitIrt = parseAmountToMinor(
    configService.get('DAILY_LIMIT_IRT', { infer: true }),
    CurrencyEnum.IRT,
  );
  if (currency === CurrencyEnum.IRT) {
    return {
      feeMinor: 0n,
      fxRateIrt: 1n,
      irtEquivalent: amountMinor,
      dailyLimitIrt,
    };
  }

  const feeMinor = parseAmountToMinor(
    configService.get('USDT_WITHDRAWAL_FEE', { infer: true }),
    CurrencyEnum.USDT,
    { allowZero: true },
  );
  const fxRateIrt = parseAmountToMinor(
    configService.get('USDT_IRT_RATE', { infer: true }),
    CurrencyEnum.IRT,
  );
  return {
    feeMinor,
    fxRateIrt,
    irtEquivalent: convertUsdtToIrtCeiling(amountMinor, fxRateIrt),
    dailyLimitIrt,
  };
}

export function isWebhookAmountValid(
  expectedCurrency: CurrencyEnum,
  expectedMinor: bigint,
  providedAmount: string | number,
  providedCurrency?: string | null,
): boolean {
  const normCcy = providedCurrency?.trim().toUpperCase();
  try {
    if (expectedCurrency === CurrencyEnum.IRT) {
      if (normCcy === CurrencyEnum.IRT) {
        return (
          parseAmountToMinor(String(providedAmount), CurrencyEnum.IRT) ===
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
      parseAmountToMinor(String(providedAmount), CurrencyEnum.USDT) ===
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
