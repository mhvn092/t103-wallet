export enum CurrencyEnum {
  IRT = 'IRT',
  USDT = 'USDT',
}

export const CURRENCIES = Object.values(CurrencyEnum) as [
  CurrencyEnum,
  ...CurrencyEnum[],
];
