import { describe, expect, it } from 'vitest';
import type { PayoutStatusValue } from '../providers/provider.types.js';
import {
  type WithdrawalStatus,
  decideWithdrawalTransition,
} from './withdrawal-state-machine.util.js';

const ALL_STATUSES: WithdrawalStatus[] = [
  'PENDING_DISPATCH',
  'DISPATCHING',
  'PROCESSING',
  'MANUAL_REVIEW',
  'SUCCEEDED',
  'FAILED',
];

const PROVIDER_EVENTS: PayoutStatusValue[] = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'RETURNED',
  'REVERSED',
];

describe('withdrawal-state-machine.util', () => {
  it('blocks false WD_LATE_SUCCESS after RETURNED/REVERSED while PROCESSING (F-01)', () => {
    const onReturned = decideWithdrawalTransition(
      {
        status: 'PROCESSING',
        failureReason: null,
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: false,
      },
      { kind: 'PROVIDER_STATUS', status: 'RETURNED' },
    );
    expect(onReturned).toEqual({
      kind: 'FAIL_AND_RELEASE',
      markTerminalReturn: true,
    });

    const delayedSucceeded = decideWithdrawalTransition(
      {
        status: 'FAILED',
        failureReason: 'BANK_RETURNED',
        terminalReturn: true,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: true,
      },
      { kind: 'PROVIDER_STATUS', status: 'SUCCEEDED' },
    );
    expect(delayedSucceeded).toEqual({ kind: 'NOOP' });
  });

  it('requires authoritative verification on unconfirmed webhook SUCCEEDED when FAILED', () => {
    const unverifiedWebhook = decideWithdrawalTransition(
      {
        status: 'FAILED',
        failureReason: 'PROVIDER_FAILED',
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: false,
      },
      { kind: 'PROVIDER_STATUS', status: 'SUCCEEDED' },
    );
    expect(unverifiedWebhook).toEqual({ kind: 'NEEDS_AUTHORITATIVE_VERIFY' });

    const verifiedPoller = decideWithdrawalTransition(
      {
        status: 'FAILED',
        failureReason: 'PROVIDER_FAILED',
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: true,
      },
      { kind: 'PROVIDER_STATUS', status: 'SUCCEEDED' },
    );
    expect(verifiedPoller).toEqual({ kind: 'LATE_SUCCESS_CLAWBACK' });
  });

  it('marks terminalReturn on FAILED rows receiving delayed RETURNED/REVERSED', () => {
    const action = decideWithdrawalTransition(
      {
        status: 'FAILED',
        failureReason: 'PROVIDER_FAILED',
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: false,
      },
      { kind: 'PROVIDER_STATUS', status: 'REVERSED' },
    );
    expect(action).toEqual({ kind: 'MARK_TERMINAL_RETURN_ONLY' });
  });

  it('enforces strict USER_CANCEL and OPS_RESOLVE rules across all statuses', () => {
    for (const status of ALL_STATUSES) {
      const cancelAction = decideWithdrawalTransition(
        {
          status,
          failureReason: null,
          terminalReturn: false,
          lateSuccessConflict: false,
          hasPriorSettlementOrReturn: false,
          authoritativeConfirmed: false,
        },
        { kind: 'USER_CANCEL' },
      );
      if (status === 'PENDING_DISPATCH') {
        expect(cancelAction).toEqual({
          kind: 'FAIL_AND_RELEASE',
          markTerminalReturn: false,
        });
      } else {
        expect(cancelAction.kind).toBe('INVALID_TRANSITION');
      }

      const resolveOk = decideWithdrawalTransition(
        {
          status,
          failureReason: null,
          terminalReturn: false,
          lateSuccessConflict: false,
          hasPriorSettlementOrReturn: false,
          authoritativeConfirmed: true,
        },
        { kind: 'OPS_RESOLVE', outcome: 'SUCCEEDED' },
      );
      expect(resolveOk.kind).toBe(
        status === 'MANUAL_REVIEW' ? 'SETTLE' : 'INVALID_TRANSITION',
      );
    }
  });

  it('evaluates the entire Cartesian product of states, flags, and provider events deterministically', () => {
    const bools = [false, true] as const;
    for (const status of ALL_STATUSES) {
      for (const terminalReturn of bools) {
        for (const lateSuccessConflict of bools) {
          for (const hasPriorSettlementOrReturn of bools) {
            for (const authoritativeConfirmed of bools) {
              for (const providerStatus of PROVIDER_EVENTS) {
                const action = decideWithdrawalTransition(
                  {
                    status,
                    failureReason: null,
                    terminalReturn,
                    lateSuccessConflict,
                    hasPriorSettlementOrReturn,
                    authoritativeConfirmed,
                  },
                  { kind: 'PROVIDER_STATUS', status: providerStatus },
                );
                expect(action.kind).toBeDefined();
                expect(action.kind).not.toBe('INVALID_TRANSITION');
              }
            }
          }
        }
      }
    }
  });
});
