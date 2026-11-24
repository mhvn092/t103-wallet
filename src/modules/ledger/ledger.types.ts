import type { Currency } from '../../common/utils/money.js';
import type { AccountRow } from '../../database/schema/index.js';

export type LedgerTxType =
  | 'DEPOSIT'
  | 'WD_HOLD'
  | 'WD_SETTLE'
  | 'WD_RELEASE'
  | 'WD_RETURN'
  | 'WD_LATE_SUCCESS'
  | 'OPS_ADJ'
  | 'TRANSFER';

export type LedgerRefType =
  'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'TRANSFER';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerPostingLine {
  account: AccountRow;
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
    accountType: string;
    direction: LedgerDirection;
    amount: bigint;
    balanceAfter: bigint | null;
  }>;
}
