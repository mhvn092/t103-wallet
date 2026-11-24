import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

export class AdjustmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  adjustmentId!: string;

  @ApiProperty({ example: 'user_1' })
  userId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: Currency;

  @ApiProperty({ example: '500000' })
  amount!: string;

  @ApiProperty({ example: 'deposit delay compensation' })
  reason!: string;

  @ApiProperty({ example: 'ops-ehsan' })
  operatorId!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
