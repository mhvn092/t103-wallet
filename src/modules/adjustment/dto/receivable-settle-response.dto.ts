import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

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
