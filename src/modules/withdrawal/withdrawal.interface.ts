import type { WithdrawalEntity } from './withdrawal.types.js';

export interface ClaimedWithdrawalDispatchItemInterface {
  row: WithdrawalEntity;
  wasRecovery: boolean;
  claimedVersion: bigint;
}

export interface WithdrawalPolicyAmountsInterface {
  feeMinor: bigint;
  fxRateIrt: bigint;
  irtEquivalent: bigint;
  dailyLimitIrt: bigint;
}
