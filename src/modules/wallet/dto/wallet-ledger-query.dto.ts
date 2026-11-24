import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, Matches, Max, Min, ValidateIf } from 'class-validator';
import { CURRENCIES, type Currency } from '../../../common/utils/money.js';
import type { UserAccountType } from '../wallet.types.js';

const ACCOUNT_FILTERS = ['AVAILABLE', 'LOCKED', 'RECEIVABLE', 'ALL'] as const;

function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function parseStrictLimit(value: unknown): number {
  if (value === undefined || value === '') {
    return 20;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      return Number(trimmed);
    }
  }
  return Number.NaN;
}

export class WalletLedgerQueryDto {
  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 100,
    example: 20,
  })
  @Transform(({ value }) => parseStrictLimit(value))
  @IsInt({ message: 'limit must be a positive integer between 1 and 100' })
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Keyset pagination cursor (last seen ledger item ID)',
    example: '42',
  })
  @Transform(({ value }) => emptyToUndefined(value))
  @ValidateIf((o: WalletLedgerQueryDto) => o.cursor !== undefined)
  @Matches(/^[1-9]\d*$/, {
    message: 'cursor must be a positive integer ledger item ID',
  })
  cursor?: string;

  @ApiPropertyOptional({
    enum: ACCOUNT_FILTERS,
    default: 'AVAILABLE',
  })
  @Transform(({ value }) => emptyToUndefined(value) ?? 'AVAILABLE')
  @IsIn(ACCOUNT_FILTERS, {
    message: 'accountType must be AVAILABLE, LOCKED, RECEIVABLE, or ALL',
  })
  accountType: UserAccountType | 'ALL' = 'AVAILABLE';

  @ApiPropertyOptional({ enum: CURRENCIES })
  @Transform(({ value }) => emptyToUndefined(value))
  @ValidateIf((o: WalletLedgerQueryDto) => o.currency !== undefined)
  @IsIn(CURRENCIES, { message: 'currency must be IRT or USDT' })
  currency?: Currency;
}
