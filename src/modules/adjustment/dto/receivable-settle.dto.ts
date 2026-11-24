import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { UserScopedDto } from '../../../common/dto/user-scoped.dto.js';
import { CURRENCIES, type Currency } from '../../../common/utils/money.js';

export class ReceivableSettleDto extends UserScopedDto {
  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  @IsIn(CURRENCIES)
  currency!: Currency;

  @ApiPropertyOptional({
    description:
      'Optional positive settlement amount (defaults to min(available, receivable))',
    example: '150000',
  })
  @IsOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  amount?: string;
}

export class ReceivableSettleResponseDto {
  @ApiProperty({ format: 'uuid' })
  settlementId!: string;

  @ApiProperty({ example: 'user_alice' })
  userId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: Currency;

  @ApiProperty({ example: '150000' })
  settledAmount!: string;

  @ApiProperty({ example: '0' })
  remainingReceivable!: string;

  @ApiProperty({ example: false })
  outboundFrozen!: boolean;
}

