import type { Currency } from '../../common/utils/money.util.js';

export type UserAccountType = 'AVAILABLE' | 'LOCKED' | 'RECEIVABLE';
type NormalSide = 'DEBIT' | 'CREDIT';

export const USER_ACCOUNT_NORMAL_SIDE: Record<UserAccountType, NormalSide> = {
  AVAILABLE: 'CREDIT',
  LOCKED: 'CREDIT',
  RECEIVABLE: 'DEBIT',
};

export interface AccountSpec {
  userId: string;
  currency: Currency;
  accountType: UserAccountType;
}

export type SystemOwnerId =
  'PSP_CLEARING' | 'PAYOUT_CLEARING' | 'OPS_ADJUSTMENT' | 'FEE_REVENUE';

export interface WalletBalanceView {
  currency: Currency;
  available: string;
  locked: string;
  receivable: string;
}
