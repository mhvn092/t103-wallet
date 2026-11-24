import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

export class WithdrawalsPauseResponseDto {
  @ApiProperty({ enum: CURRENCIES, isArray: true, example: ['USDT'] })
  currencies!: Currency[];

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
