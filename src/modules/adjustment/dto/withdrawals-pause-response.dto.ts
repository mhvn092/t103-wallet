import { ApiProperty } from '@nestjs/swagger';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

export class WithdrawalsPauseResponseDto {
  @ApiProperty({ enum: CURRENCIES, isArray: true, example: ['USDT'] })
  currencies!: CurrencyEnum[];

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
