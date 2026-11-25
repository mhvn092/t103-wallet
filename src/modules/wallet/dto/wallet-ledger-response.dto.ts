import { ApiProperty } from '@nestjs/swagger';
import { AccountTypeEnum } from '../../../common/enums/account.enums.js';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../../common/enums/ledger.enums.js';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

class WalletLedgerItemDto {
  @ApiProperty({ example: '101' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: LedgerTxTypeEnum, example: LedgerTxTypeEnum.DEPOSIT })
  type!: LedgerTxTypeEnum;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: CurrencyEnum;

  @ApiProperty({ enum: AccountTypeEnum, example: AccountTypeEnum.AVAILABLE })
  accountType!: AccountTypeEnum;

  @ApiProperty({
    enum: LedgerDirectionEnum,
    example: LedgerDirectionEnum.CREDIT,
  })
  direction!: LedgerDirectionEnum;

  @ApiProperty({ example: '500000' })
  amount!: string;

  @ApiProperty({ type: String, nullable: true, example: '500000' })
  balanceAfter!: string | null;

  @ApiProperty({ enum: LedgerRefTypeEnum, example: LedgerRefTypeEnum.DEPOSIT })
  referenceType!: LedgerRefTypeEnum;

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
