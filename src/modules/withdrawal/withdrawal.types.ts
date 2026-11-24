import type { withdrawals } from '../../database/schema/index.js';

export type WithdrawalEntity = typeof withdrawals.$inferSelect;

export interface ClaimedWithdrawalDispatchItem {
  row: WithdrawalEntity;
  wasRecovery: boolean;
  claimedVersion: bigint;
}

export interface WithdrawalPolicyAmounts {
  feeMinor: bigint;
  fxRateIrt: bigint;
  irtEquivalent: bigint;
  dailyLimitIrt: bigint;
}
