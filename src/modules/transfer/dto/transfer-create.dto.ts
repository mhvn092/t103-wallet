import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { UserIdField } from '../../../common/decorators/user-id-field.decorator.js';
import { CURRENCIES, type Currency } from '../../../common/utils/money.js';

export class TransferCreateDto {
  @UserIdField('Sender user identifier', 'user_alice')
  fromUserId!: string;

  @UserIdField('Recipient user identifier', 'user_bob')
  toUserId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  @IsIn(CURRENCIES)
  currency!: Currency;

  @ApiProperty({
    description: 'Transfer amount (IRT integer or USDT up to 6 decimals)',
    example: '150000',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  amount!: string;
}
