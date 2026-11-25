import { ApiProperty } from '@nestjs/swagger';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

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
  pausedWithdrawalCurrencies!: CurrencyEnum[];
}
