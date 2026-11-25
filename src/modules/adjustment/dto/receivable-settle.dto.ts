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
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

export class ReceivableSettleDto extends UserScopedDto {
  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  @IsIn(CURRENCIES)
  currency!: CurrencyEnum;

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
