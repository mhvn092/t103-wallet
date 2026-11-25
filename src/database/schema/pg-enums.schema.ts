import { pgEnum } from 'drizzle-orm/pg-core';
import {
  AccountOwnerTypeEnum,
  AccountTypeEnum,
} from '../../common/enums/account.enums.js';
import { CurrencyEnum } from '../../common/enums/currency.enum.js';
import { DepositStatusEnum } from '../../common/enums/deposit.enums.js';
import {
  DiscrepancyRefTypeEnum,
  DiscrepancyStatusEnum,
  DiscrepancyTypeEnum,
} from '../../common/enums/discrepancy.enums.js';
import { IdempotencyStatusEnum } from '../../common/enums/idempotency.enums.js';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../common/enums/ledger.enums.js';
import {
  OutboxEventTypeEnum,
  OutboxStatusEnum,
} from '../../common/enums/outbox.enums.js';
import { WithdrawalStatusEnum } from '../../common/enums/withdrawal.enums.js';

export const accountOwnerTypeEnum = pgEnum(
  'account_owner_type',
  AccountOwnerTypeEnum,
);
export const currencyEnum = pgEnum('currency', CurrencyEnum);
export const accountTypeEnum = pgEnum('account_type', AccountTypeEnum);
export const ledgerDirectionEnum = pgEnum(
  'ledger_direction',
  LedgerDirectionEnum,
);
export const ledgerTxTypeEnum = pgEnum('ledger_tx_type', LedgerTxTypeEnum);
export const ledgerRefTypeEnum = pgEnum('ledger_ref_type', LedgerRefTypeEnum);
export const idempotencyStatusEnum = pgEnum(
  'idempotency_status',
  IdempotencyStatusEnum,
);
export const depositStatusEnum = pgEnum('deposit_status', DepositStatusEnum);
export const withdrawalStatusEnum = pgEnum(
  'withdrawal_status',
  WithdrawalStatusEnum,
);
export const discrepancyRefTypeEnum = pgEnum(
  'discrepancy_ref_type',
  DiscrepancyRefTypeEnum,
);
export const discrepancyTypeEnum = pgEnum(
  'discrepancy_type',
  DiscrepancyTypeEnum,
);
export const discrepancyStatusEnum = pgEnum(
  'discrepancy_status',
  DiscrepancyStatusEnum,
);
export const outboxEventTypeEnum = pgEnum(
  'outbox_event_type',
  OutboxEventTypeEnum,
);
export const outboxStatusEnum = pgEnum('outbox_status', OutboxStatusEnum);
