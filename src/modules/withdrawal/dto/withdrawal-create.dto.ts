import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { UserScopedDto } from '../../../common/dto/user-scoped.dto.js';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

export class WithdrawalCreateDto extends UserScopedDto {
  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  @IsIn(CURRENCIES)
  currency!: Currency;

  @ApiProperty({
    description: 'Withdrawal amount (IRT integer or USDT up to 6 decimals)',
    example: '250000',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  amount!: string;

  @ApiProperty({
    description: 'Iranian IBAN for IRT or Base58Check TRC20 address for USDT',
    example: 'IR062960000000100324200001',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  destination!: string;
}
