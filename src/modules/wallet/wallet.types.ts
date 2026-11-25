import {
  AccountType,
  Currency,
  LedgerDirection,
  SystemOwnerId,
  UserAccountType,
} from '../../common/enums/domain.enums.js';

export { SystemOwnerId, UserAccountType };

export const USER_ACCOUNT_NORMAL_SIDE: Record<
  UserAccountType,
  LedgerDirection
> = {
  [UserAccountType.AVAILABLE]: LedgerDirection.CREDIT,
  [UserAccountType.LOCKED]: LedgerDirection.CREDIT,
  [UserAccountType.RECEIVABLE]: LedgerDirection.DEBIT,
};

export const USER_TO_ACCOUNT_TYPE: Record<UserAccountType, AccountType> = {
  [UserAccountType.AVAILABLE]: AccountType.AVAILABLE,
  [UserAccountType.LOCKED]: AccountType.LOCKED,
  [UserAccountType.RECEIVABLE]: AccountType.RECEIVABLE,
};

export interface AccountSpec {
  userId: string;
  currency: Currency;
  accountType: UserAccountType;
}

export interface WalletBalanceView {
  currency: Currency;
  available: string;
  locked: string;
  receivable: string;
}
