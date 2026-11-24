import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

export class TransferResponseDto {
  @ApiProperty({ format: 'uuid' })
  transferId!: string;

  @ApiProperty({ example: 'user_alice' })
  fromUserId!: string;

  @ApiProperty({ example: 'user_bob' })
  toUserId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: Currency;

  @ApiProperty({ example: '150000' })
  amount!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
