import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '../../../common/utils/money.js';

class WalletLedgerItemDto {
  @ApiProperty({ example: '101' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'DEPOSIT' })
  type!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: Currency;

  @ApiProperty({ example: 'AVAILABLE' })
  accountType!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'], example: 'CREDIT' })
  direction!: string;

  @ApiProperty({ example: '500000' })
  amount!: string;

  @ApiProperty({ type: String, nullable: true, example: '500000' })
  balanceAfter!: string | null;

  @ApiProperty({ example: 'DEPOSIT' })
  referenceType!: string;

  @ApiProperty({ format: 'uuid' })
  referenceId!: string;

  @ApiProperty({ example: 'Verified PSP deposit' })
  description!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class WalletLedgerResponseDto {
  @ApiProperty({ type: [WalletLedgerItemDto] })
  items!: WalletLedgerItemDto[];

  @ApiProperty({ type: String, nullable: true, example: '100' })
  nextCursor!: string | null;
}
