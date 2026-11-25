export enum PspStatusValueEnum {
  INIT = 'INIT',
  PAID = 'PAID',
  VERIFIED = 'VERIFIED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

export enum PspVerifyStatusValueEnum {
  OK = 'OK',
  ALREADY_VERIFIED = 'ALREADY_VERIFIED',
  FAILED = 'FAILED',
}

export enum PayoutStatusValueEnum {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  RETURNED = 'RETURNED',
  REVERSED = 'REVERSED',
}

export enum PayoutTransferTypeEnum {
  IBAN = 'IBAN',
  CRYPTO = 'CRYPTO',
}

export enum PayoutCurrencyEnum {
  IRR = 'IRR',
  USDT = 'USDT',
}
