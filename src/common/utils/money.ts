import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode } from '../errors/error-codes.js';

export const CURRENCIES = ['IRT', 'USDT'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const USDT_SCALE = 6;
export const USDT_MINOR_PER_UNIT = 1_000_000n;
const IRT_REGEX = /^[1-9]\d*$/;
const USDT_REGEX = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export function isCurrency(value: unknown): value is Currency {
  return value === 'IRT' || value === 'USDT';
}

export function parseAmountToMinor(
  raw: string,
  currency: Currency,
  options: { allowZero?: boolean } = {},
): bigint {
  const trimmed = raw.trim();
  if (currency === 'IRT') {
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
    return BigInt(trimmed);
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
  return minor;
}

export function formatMinorToApi(minor: bigint, currency: Currency): string {
  if (minor < 0n) {
    throw new Error(`Unexpected negative minor unit: ${minor.toString()}`);
  }
  if (currency === 'IRT') {
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

export function formatMinorFixedUsdt(minor: bigint): string {
  const whole = minor / USDT_MINOR_PER_UNIT;
  const frac = (minor % USDT_MINOR_PER_UNIT)
    .toString()
    .padStart(USDT_SCALE, '0');
  return `${whole.toString()}.${frac}`;
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
