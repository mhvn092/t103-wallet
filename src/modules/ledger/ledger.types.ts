import {
  AccountType,
  Currency,
  LedgerDirection,
  LedgerRefType,
  LedgerTxType,
} from '../../common/enums/domain.enums.js';
import type { AccountEntity } from '../../database/schema/index.js';

export { LedgerDirection, LedgerRefType, LedgerTxType };

export interface LedgerPostingLine {
  account: AccountEntity;
  direction: LedgerDirection;
  amount: bigint;
}

export interface PostLedgerTxInput {
  type: LedgerTxType;
  referenceType: LedgerRefType;
  referenceId: string;
  description: string;
  metadata?: Record<string, unknown>;
  postings: LedgerPostingLine[];
}

export interface PostLedgerTxResult {
  transactionId: string;
  items: Array<{
    id: bigint;
    accountId: string;
    userId: string | null;
    currency: Currency;
    accountType: AccountType;
    direction: LedgerDirection;
    amount: bigint;
    balanceAfter: bigint | null;
  }>;
}
