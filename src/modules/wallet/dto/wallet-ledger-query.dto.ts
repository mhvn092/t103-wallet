import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';
import { emptyToUndefined } from '../../../common/utils/string-normalizer.util.js';
import {
  WALLET_ACCOUNT_FILTERS,
  isValidPositiveBigIntCursor,
  parseStrictLimit,
} from '../wallet-ledger-query.util.js';
import type { UserAccountType } from '../wallet.types.js';

@ValidatorConstraint({ name: 'positiveBigIntCursor', async: false })
class PositiveBigIntCursorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidPositiveBigIntCursor(value);
  }

  defaultMessage(): string {
    return 'cursor must be a positive 64-bit integer ledger item ID';
  }
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
  @Validate(PositiveBigIntCursorConstraint)
  cursor?: string;

  @ApiPropertyOptional({
    enum: WALLET_ACCOUNT_FILTERS,
    default: 'AVAILABLE',
  })
  @Transform(({ value }) => emptyToUndefined(value) ?? 'AVAILABLE')
  @IsIn(WALLET_ACCOUNT_FILTERS, {
    message: 'accountType must be AVAILABLE, LOCKED, RECEIVABLE, or ALL',
  })
  accountType: UserAccountType | 'ALL' = 'AVAILABLE';

  @ApiPropertyOptional({ enum: CURRENCIES })
  @Transform(({ value }) => emptyToUndefined(value))
  @ValidateIf((o: WalletLedgerQueryDto) => o.currency !== undefined)
  @IsIn(CURRENCIES, { message: 'currency must be IRT or USDT' })
  currency?: Currency;
}
