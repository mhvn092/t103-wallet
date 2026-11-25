import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import { UserAccountTypeEnum } from '../../common/enums/account.enums.js';

export interface AccountSpecInterface {
  userId: string;
  currency: CurrencyEnum;
  accountType: UserAccountTypeEnum;
}

export interface WalletBalanceViewInterface {
  currency: CurrencyEnum;
  available: string;
  locked: string;
  receivable: string;
}
