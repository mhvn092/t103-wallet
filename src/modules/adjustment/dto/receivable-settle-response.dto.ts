import { ApiProperty } from '@nestjs/swagger';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

export class ReceivableSettleResponseDto {
  @ApiProperty({ format: 'uuid' })
  settlementId!: string;

  @ApiProperty({ example: 'user_alice' })
  userId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: CurrencyEnum;

  @ApiProperty({ example: '150000' })
  settledAmount!: string;

  @ApiProperty({ example: '0' })
  remainingReceivable!: string;

  @ApiProperty({ example: false })
  outboundFrozen!: boolean;
}
