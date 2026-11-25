import { ApiProperty } from '@nestjs/swagger';
import {
  AccountType,
  LedgerDirection,
  LedgerRefType,
  LedgerTxType,
} from '../../../common/enums/domain.enums.js';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

class WalletLedgerItemDto {
  @ApiProperty({ example: '101' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: LedgerTxType, example: LedgerTxType.DEPOSIT })
  type!: LedgerTxType;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: Currency;

  @ApiProperty({ enum: AccountType, example: AccountType.AVAILABLE })
  accountType!: AccountType;

  @ApiProperty({ enum: LedgerDirection, example: LedgerDirection.CREDIT })
  direction!: LedgerDirection;

  @ApiProperty({ example: '500000' })
  amount!: string;

  @ApiProperty({ type: String, nullable: true, example: '500000' })
  balanceAfter!: string | null;

  @ApiProperty({ enum: LedgerRefType, example: LedgerRefType.DEPOSIT })
  referenceType!: LedgerRefType;

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
