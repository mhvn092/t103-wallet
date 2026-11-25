import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { UserScopedDto } from '../../../common/dto/user-scoped.dto.js';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

export class AdjustmentCreateDto extends UserScopedDto {
  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  @IsIn(CURRENCIES)
  currency!: CurrencyEnum;

  @ApiProperty({ example: '500000' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  amount!: string;

  @ApiProperty({ example: 'deposit delay compensation' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
