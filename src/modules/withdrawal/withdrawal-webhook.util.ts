import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import { PayoutCurrencyEnum } from '../../common/enums/provider.enums.js';
import { isWebhookAmountValid } from './withdrawal.mapper.js';
import type { WithdrawalEntity } from './withdrawal.types.js';

export function detectProviderPayloadMismatch(
  row: Pick<WithdrawalEntity, 'currency' | 'amount'>,
  payload: { amount?: string | number | null; currency?: string | null },
): boolean {
  if (
    (payload.amount === undefined || payload.amount === null) &&
    !payload.currency
  ) {
    return false;
  }

  const expectedCurrency = row.currency;
  const expectedMinor = BigInt(row.amount);
  const normCcy = payload.currency?.trim().toUpperCase();

  const currencyMismatch = Boolean(
    normCcy &&
    ((expectedCurrency === CurrencyEnum.IRT &&
      normCcy !== PayoutCurrencyEnum.IRR &&
      normCcy !== CurrencyEnum.IRT) ||
      (expectedCurrency === CurrencyEnum.USDT &&
        normCcy !== PayoutCurrencyEnum.USDT)),
  );

  const amountMismatch =
    payload.amount !== undefined &&
    payload.amount !== null &&
    !isWebhookAmountValid(
      expectedCurrency,
      expectedMinor,
      payload.amount,
      payload.currency,
    );

  return currencyMismatch || amountMismatch;
}
