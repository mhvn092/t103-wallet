import { PayoutStatusValueEnum } from '../../common/enums/provider.enums.js';
import {
  WithdrawalFailureReasonEnum,
  WithdrawalOpsOutcomeEnum,
  WithdrawalStatusEnum,
} from '../../common/enums/withdrawal.enums.js';

interface WithdrawalTransitionContextInterface {
  status: WithdrawalStatusEnum;
  failureReason: string | null;
  terminalReturn: boolean;
  lateSuccessConflict: boolean;
  hasPriorSettlementOrReturn: boolean;
  authoritativeConfirmed: boolean;
}

type WithdrawalEvent =
  | { kind: 'PROVIDER_STATUS'; status: PayoutStatusValueEnum }
  | { kind: 'USER_CANCEL' }
  | { kind: 'OPS_RESOLVE'; outcome: WithdrawalOpsOutcomeEnum };

type WithdrawalAction =
  | { kind: 'NOOP' }
  | { kind: 'ADVANCE_TO_PROCESSING' }
  | { kind: 'SETTLE' }
  | { kind: 'FAIL_AND_RELEASE'; markTerminalReturn: boolean }
  | { kind: 'REVERSE_SUCCEEDED' }
  | { kind: 'MARK_TERMINAL_RETURN_ONLY' }
  | { kind: 'NEEDS_AUTHORITATIVE_VERIFY' }
  | { kind: 'LATE_SUCCESS_CLAWBACK' }
  | { kind: 'INVALID_TRANSITION'; reason: string };

const INFLIGHT_STATUSES = new Set<WithdrawalStatusEnum>([
  WithdrawalStatusEnum.DISPATCHING,
  WithdrawalStatusEnum.PROCESSING,
  WithdrawalStatusEnum.MANUAL_REVIEW,
]);

export function toWithdrawalStatus(raw: string): WithdrawalStatusEnum {
  switch (raw) {
    case WithdrawalStatusEnum.PENDING_DISPATCH:
    case WithdrawalStatusEnum.DISPATCHING:
    case WithdrawalStatusEnum.PROCESSING:
    case WithdrawalStatusEnum.MANUAL_REVIEW:
    case WithdrawalStatusEnum.SUCCEEDED:
    case WithdrawalStatusEnum.FAILED:
      return raw;
    default:
      return WithdrawalStatusEnum.MANUAL_REVIEW;
  }
}

export function decideWithdrawalTransition(
  ctx: WithdrawalTransitionContextInterface,
  event: WithdrawalEvent,
): WithdrawalAction {
  if (event.kind === 'USER_CANCEL') {
    if (ctx.status === WithdrawalStatusEnum.PENDING_DISPATCH) {
      return { kind: 'FAIL_AND_RELEASE', markTerminalReturn: false };
    }
    if (
      ctx.status === WithdrawalStatusEnum.FAILED &&
      ctx.failureReason === WithdrawalFailureReasonEnum.CANCELLED_BY_USER
    ) {
      return { kind: 'NOOP' };
    }
    return {
      kind: 'INVALID_TRANSITION',
      reason: `Cannot cancel withdrawal in status ${ctx.status}`,
    };
  }

  if (event.kind === 'OPS_RESOLVE') {
    if (ctx.status !== WithdrawalStatusEnum.MANUAL_REVIEW) {
      return {
        kind: 'INVALID_TRANSITION',
        reason: `Cannot resolve withdrawal in status ${ctx.status}; MANUAL_REVIEW required`,
      };
    }
    return event.outcome === WithdrawalOpsOutcomeEnum.SUCCEEDED
      ? { kind: 'SETTLE' }
      : { kind: 'FAIL_AND_RELEASE', markTerminalReturn: false };
  }

  // event.kind === 'PROVIDER_STATUS'
  const providerStatus = event.status;
  if (
    providerStatus === PayoutStatusValueEnum.PENDING ||
    providerStatus === PayoutStatusValueEnum.PROCESSING
  ) {
    return ctx.status === WithdrawalStatusEnum.DISPATCHING
      ? { kind: 'ADVANCE_TO_PROCESSING' }
      : { kind: 'NOOP' };
  }

  if (providerStatus === PayoutStatusValueEnum.SUCCEEDED) {
    if (ctx.status === WithdrawalStatusEnum.SUCCEEDED) {
      return { kind: 'NOOP' };
    }
    if (ctx.status === WithdrawalStatusEnum.FAILED) {
      if (
        ctx.failureReason === WithdrawalFailureReasonEnum.CANCELLED_BY_USER ||
        ctx.terminalReturn ||
        ctx.lateSuccessConflict ||
        ctx.hasPriorSettlementOrReturn
      ) {
        return { kind: 'NOOP' };
      }
      if (!ctx.authoritativeConfirmed) {
        return { kind: 'NEEDS_AUTHORITATIVE_VERIFY' };
      }
      return { kind: 'LATE_SUCCESS_CLAWBACK' };
    }
    if (INFLIGHT_STATUSES.has(ctx.status)) {
      return { kind: 'SETTLE' };
    }
    return { kind: 'NOOP' };
  }

  if (providerStatus === PayoutStatusValueEnum.FAILED) {
    if (INFLIGHT_STATUSES.has(ctx.status)) {
      return { kind: 'FAIL_AND_RELEASE', markTerminalReturn: false };
    }
    return { kind: 'NOOP' };
  }

  // RETURNED | REVERSED
  if (ctx.status === WithdrawalStatusEnum.SUCCEEDED) {
    return { kind: 'REVERSE_SUCCEEDED' };
  }
  if (INFLIGHT_STATUSES.has(ctx.status)) {
    return { kind: 'FAIL_AND_RELEASE', markTerminalReturn: true };
  }
  if (ctx.status === WithdrawalStatusEnum.FAILED && !ctx.terminalReturn) {
    return { kind: 'MARK_TERMINAL_RETURN_ONLY' };
  }
  return { kind: 'NOOP' };
}
