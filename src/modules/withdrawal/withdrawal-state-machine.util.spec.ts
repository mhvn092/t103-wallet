import { describe, expect, it } from 'vitest';
import { PayoutStatusValueEnum } from '../../common/enums/provider.enums.js';
import {
  WithdrawalFailureReasonEnum,
  WithdrawalOpsOutcomeEnum,
  WithdrawalStatusEnum,
} from '../../common/enums/withdrawal.enums.js';
import { decideWithdrawalTransition } from './withdrawal-state-machine.util.js';

const ALL_STATUSES: WithdrawalStatusEnum[] =
  Object.values(WithdrawalStatusEnum);
const PROVIDER_EVENTS: PayoutStatusValueEnum[] = Object.values(
  PayoutStatusValueEnum,
);

describe('withdrawal-state-machine.util', () => {
  it('blocks false WD_LATE_SUCCESS after RETURNED/REVERSED while PROCESSING (F-01)', () => {
    const onReturned = decideWithdrawalTransition(
      {
        status: WithdrawalStatusEnum.PROCESSING,
        failureReason: null,
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: false,
      },
      { kind: 'PROVIDER_STATUS', status: PayoutStatusValueEnum.RETURNED },
    );
    expect(onReturned).toEqual({
      kind: 'FAIL_AND_RELEASE',
      markTerminalReturn: true,
    });

    const delayedSucceeded = decideWithdrawalTransition(
      {
        status: WithdrawalStatusEnum.FAILED,
        failureReason: WithdrawalFailureReasonEnum.BANK_RETURNED,
        terminalReturn: true,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: true,
      },
      { kind: 'PROVIDER_STATUS', status: PayoutStatusValueEnum.SUCCEEDED },
    );
    expect(delayedSucceeded).toEqual({ kind: 'NOOP' });
  });

  it('requires authoritative verification on unconfirmed webhook SUCCEEDED when FAILED', () => {
    const unverifiedWebhook = decideWithdrawalTransition(
      {
        status: WithdrawalStatusEnum.FAILED,
        failureReason: WithdrawalFailureReasonEnum.PROVIDER_FAILED,
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: false,
      },
      { kind: 'PROVIDER_STATUS', status: PayoutStatusValueEnum.SUCCEEDED },
    );
    expect(unverifiedWebhook).toEqual({ kind: 'NEEDS_AUTHORITATIVE_VERIFY' });

    const verifiedPoller = decideWithdrawalTransition(
      {
        status: WithdrawalStatusEnum.FAILED,
        failureReason: WithdrawalFailureReasonEnum.PROVIDER_FAILED,
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: true,
      },
      { kind: 'PROVIDER_STATUS', status: PayoutStatusValueEnum.SUCCEEDED },
    );
    expect(verifiedPoller).toEqual({ kind: 'LATE_SUCCESS_CLAWBACK' });
  });

  it('marks terminalReturn on FAILED rows receiving delayed RETURNED/REVERSED', () => {
    const action = decideWithdrawalTransition(
      {
        status: WithdrawalStatusEnum.FAILED,
        failureReason: WithdrawalFailureReasonEnum.PROVIDER_FAILED,
        terminalReturn: false,
        lateSuccessConflict: false,
        hasPriorSettlementOrReturn: false,
        authoritativeConfirmed: false,
      },
      { kind: 'PROVIDER_STATUS', status: PayoutStatusValueEnum.REVERSED },
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
      if (status === WithdrawalStatusEnum.PENDING_DISPATCH) {
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
        { kind: 'OPS_RESOLVE', outcome: WithdrawalOpsOutcomeEnum.SUCCEEDED },
      );
      expect(resolveOk.kind).toBe(
        status === WithdrawalStatusEnum.MANUAL_REVIEW
          ? 'SETTLE'
          : 'INVALID_TRANSITION',
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
