import {
  AccountTypeEnum,
  UserAccountTypeEnum,
} from '../../common/enums/account.enums.js';
import { LedgerDirectionEnum } from '../../common/enums/ledger.enums.js';

export const USER_ACCOUNT_NORMAL_SIDE: Record<
  UserAccountTypeEnum,
  LedgerDirectionEnum
> = {
  [UserAccountTypeEnum.AVAILABLE]: LedgerDirectionEnum.CREDIT,
  [UserAccountTypeEnum.LOCKED]: LedgerDirectionEnum.CREDIT,
  [UserAccountTypeEnum.RECEIVABLE]: LedgerDirectionEnum.DEBIT,
};

export const USER_TO_ACCOUNT_TYPE: Record<
  UserAccountTypeEnum,
  AccountTypeEnum
> = {
  [UserAccountTypeEnum.AVAILABLE]: AccountTypeEnum.AVAILABLE,
  [UserAccountTypeEnum.LOCKED]: AccountTypeEnum.LOCKED,
  [UserAccountTypeEnum.RECEIVABLE]: AccountTypeEnum.RECEIVABLE,
};
