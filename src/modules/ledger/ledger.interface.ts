import { AccountTypeEnum } from '../../common/enums/account.enums.js';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../common/enums/ledger.enums.js';
import type { AccountEntity } from '../../database/schema/accounts.schema.js';

export interface LedgerPostingLineInterface {
  account: AccountEntity;
  direction: LedgerDirectionEnum;
  amount: bigint;
}

export interface PostLedgerTxInputInterface {
  type: LedgerTxTypeEnum;
  referenceType: LedgerRefTypeEnum;
  referenceId: string;
  description: string;
  metadata?: Record<string, unknown>;
  postings: LedgerPostingLineInterface[];
}

export interface PostLedgerTxResultInterface {
  transactionId: string;
  items: Array<{
    id: bigint;
    accountId: string;
    userId: string | null;
    currency: CurrencyEnum;
    accountType: AccountTypeEnum;
    direction: LedgerDirectionEnum;
    amount: bigint;
    balanceAfter: bigint | null;
  }>;
}
