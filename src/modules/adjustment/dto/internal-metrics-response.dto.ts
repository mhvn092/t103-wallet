import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '../../../common/utils/money.js';

export class InternalMetricsResponseDto {
  @ApiProperty({ example: 0 })
  openDiscrepancies!: number;

  @ApiProperty({ example: 0 })
  manualReviewWithdrawals!: number;

  @ApiProperty({ example: 0 })
  pendingOutboxEvents!: number;

  @ApiProperty({ example: 0 })
  balanceDriftAccounts!: number;

  @ApiProperty({ enum: CURRENCIES, isArray: true, example: [] })
  pausedWithdrawalCurrencies!: Currency[];
}
