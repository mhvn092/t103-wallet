import { HttpStatus } from '@nestjs/common';
import { Currency } from '../../common/enums/domain.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { formatMinorToApi } from '../../common/utils/money.util.js';

export function formatSignedIrtMinor(minor: bigint): string {
  return minor < 0n
    ? `-${formatMinorToApi(-minor, Currency.IRT)}`
    : formatMinorToApi(minor, Currency.IRT);
}

export function assertValidCalendarDate(dateStr: string): string {
  const [yStr, mStr, dStr] = dateStr.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      `Invalid calendar date: ${dateStr}`,
    );
  }
  return dateStr;
}
