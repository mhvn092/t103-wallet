import { ApiProperty } from '@nestjs/swagger';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

class WalletBalanceItemDto {
  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: CurrencyEnum;

  @ApiProperty({ example: '1500000' })
  available!: string;

  @ApiProperty({ example: '200000' })
  locked!: string;

  @ApiProperty({ example: '0' })
  receivable!: string;
}

export class WalletBalancesResponseDto {
  @ApiProperty({ example: 'user_1' })
  userId!: string;

  @ApiProperty({ type: [WalletBalanceItemDto] })
  balances!: WalletBalanceItemDto[];
}
