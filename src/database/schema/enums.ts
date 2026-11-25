import { pgEnum } from 'drizzle-orm/pg-core';
import {
  AccountOwnerType,
  AccountType,
  Currency,
  DepositStatus,
  DiscrepancyRefType,
  DiscrepancyStatus,
  DiscrepancyType,
  IdempotencyStatus,
  LedgerDirection,
  LedgerRefType,
  LedgerTxType,
  OutboxEventType,
  OutboxStatus,
  WithdrawalStatus,
} from '../../common/enums/domain.enums.js';

export const accountOwnerTypeEnum = pgEnum(
  'account_owner_type',
  AccountOwnerType,
);
export const currencyEnum = pgEnum('currency', Currency);
export const accountTypeEnum = pgEnum('account_type', AccountType);
export const ledgerDirectionEnum = pgEnum('ledger_direction', LedgerDirection);
export const ledgerTxTypeEnum = pgEnum('ledger_tx_type', LedgerTxType);
export const ledgerRefTypeEnum = pgEnum('ledger_ref_type', LedgerRefType);
export const idempotencyStatusEnum = pgEnum(
  'idempotency_status',
  IdempotencyStatus,
);
export const depositStatusEnum = pgEnum('deposit_status', DepositStatus);
export const withdrawalStatusEnum = pgEnum(
  'withdrawal_status',
  WithdrawalStatus,
);
export const discrepancyRefTypeEnum = pgEnum(
  'discrepancy_ref_type',
  DiscrepancyRefType,
);
export const discrepancyTypeEnum = pgEnum('discrepancy_type', DiscrepancyType);
export const discrepancyStatusEnum = pgEnum(
  'discrepancy_status',
  DiscrepancyStatus,
);
export const outboxEventTypeEnum = pgEnum('outbox_event_type', OutboxEventType);
export const outboxStatusEnum = pgEnum('outbox_status', OutboxStatus);
