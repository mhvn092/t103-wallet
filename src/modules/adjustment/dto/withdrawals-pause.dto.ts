import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

export class WithdrawalsPauseDto {
  @ApiProperty({
    enum: CURRENCIES,
    isArray: true,
    example: ['USDT'],
    description:
      'Currencies for which new outbound withdrawals are temporarily paused',
  })
  @IsArray()
  @ArrayUnique()
  @IsIn(CURRENCIES, { each: true })
  currencies!: Currency[];

  @ApiPropertyOptional({ example: '02:10 deployment incident containment' })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
