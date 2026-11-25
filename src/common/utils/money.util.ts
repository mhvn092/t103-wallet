import { HttpStatus } from '@nestjs/common';
import { CurrencyEnum } from '../enums/currency.enum.js';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode } from '../errors/error-codes.js';

const USDT_SCALE = 6;
export const USDT_MINOR_PER_UNIT = 1_000_000n;
export const MAX_AMOUNT_MINOR = 10n ** 15n;
const IRT_REGEX = /^[1-9]\d*$/;
const USDT_REGEX = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

function assertWithinMaxAmount(minor: bigint): bigint {
  if (minor > MAX_AMOUNT_MINOR) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      'Amount exceeds maximum allowed magnitude',
    );
  }
  return minor;
}

export function parseAmountToMinor(
  raw: string,
  currency: CurrencyEnum,
  options: { allowZero?: boolean } = {},
): bigint {
  const trimmed = raw.trim();
  if (currency === CurrencyEnum.IRT) {
    if (options.allowZero && trimmed === '0') {
      return 0n;
    }
    if (!IRT_REGEX.test(trimmed)) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'IRT amount must be a positive integer string',
      );
    }
    return assertWithinMaxAmount(BigInt(trimmed));
  }

  if (!USDT_REGEX.test(trimmed)) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      'USDT amount must be a positive decimal string with up to 6 decimal places',
    );
  }

  const [wholePart = '0', fracPart = ''] = trimmed.split('.');
  const paddedFrac = fracPart.padEnd(USDT_SCALE, '0');
  const minor = BigInt(wholePart) * USDT_MINOR_PER_UNIT + BigInt(paddedFrac);

  if (!options.allowZero && minor <= 0n) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      'USDT amount must be greater than zero',
    );
  }
  return assertWithinMaxAmount(minor);
}

export function formatMinorToApi(
  minor: bigint,
  currency: CurrencyEnum,
): string {
  if (minor < 0n) {
    throw new DomainException(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.INTERNAL_ERROR,
      `Unexpected negative minor unit: ${minor.toString()}`,
    );
  }
  if (currency === CurrencyEnum.IRT) {
    return minor.toString();
  }
  if (minor === 0n) {
    return '0';
  }
  const whole = minor / USDT_MINOR_PER_UNIT;
  const frac = (minor % USDT_MINOR_PER_UNIT)
    .toString()
    .padStart(USDT_SCALE, '0')
    .replace(/0+$/, '');
  return frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
}

export function convertUsdtToIrtCeiling(
  usdtMinor: bigint,
  fxRateIrtPerUsdt: bigint,
): bigint {
  if (usdtMinor <= 0n) {
    return 0n;
  }
  return (
    (usdtMinor * fxRateIrtPerUsdt + (USDT_MINOR_PER_UNIT - 1n)) /
    USDT_MINOR_PER_UNIT
  );
}
