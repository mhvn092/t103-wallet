import type { PayoutStatusValue } from '../providers/provider.types.js';

export type WithdrawalStatus =
  | 'PENDING_DISPATCH'
  | 'DISPATCHING'
  | 'PROCESSING'
  | 'MANUAL_REVIEW'
  | 'SUCCEEDED'
  | 'FAILED';

export interface WithdrawalTransitionContext {
  status: WithdrawalStatus;
  failureReason: string | null;
  terminalReturn: boolean;
  lateSuccessConflict: boolean;
  hasPriorSettlementOrReturn: boolean;
  authoritativeConfirmed: boolean;
}

export type WithdrawalEvent =
  | { kind: 'PROVIDER_STATUS'; status: PayoutStatusValue }
  | { kind: 'USER_CANCEL' }
  | { kind: 'OPS_RESOLVE'; outcome: 'SUCCEEDED' | 'FAILED' };

export type WithdrawalAction =
  | { kind: 'NOOP' }
  | { kind: 'ADVANCE_TO_PROCESSING' }
  | { kind: 'SETTLE' }
  | { kind: 'FAIL_AND_RELEASE'; markTerminalReturn: boolean }
  | { kind: 'REVERSE_SUCCEEDED' }
  | { kind: 'MARK_TERMINAL_RETURN_ONLY' }
  | { kind: 'NEEDS_AUTHORITATIVE_VERIFY' }
  | { kind: 'LATE_SUCCESS_CLAWBACK' }
  | { kind: 'INVALID_TRANSITION'; reason: string };

const INFLIGHT_STATUSES = new Set<WithdrawalStatus>([
  'DISPATCHING',
  'PROCESSING',
  'MANUAL_REVIEW',
]);

export function toWithdrawalStatus(raw: string): WithdrawalStatus {
  switch (raw) {
    case 'PENDING_DISPATCH':
    case 'DISPATCHING':
    case 'PROCESSING':
    case 'MANUAL_REVIEW':
    case 'SUCCEEDED':
    case 'FAILED':
      return raw;
    default:
      return 'MANUAL_REVIEW';
  }
}

export function decideWithdrawalTransition(
  ctx: WithdrawalTransitionContext,
  event: WithdrawalEvent,
): WithdrawalAction {
  if (event.kind === 'USER_CANCEL') {
    if (ctx.status === 'PENDING_DISPATCH') {
      return { kind: 'FAIL_AND_RELEASE', markTerminalReturn: false };
    }
    if (ctx.status === 'FAILED' && ctx.failureReason === 'CANCELLED_BY_USER') {
      return { kind: 'NOOP' };
    }
    return {
      kind: 'INVALID_TRANSITION',
      reason: `Cannot cancel withdrawal in status ${ctx.status}`,
    };
  }

  if (event.kind === 'OPS_RESOLVE') {
    if (ctx.status !== 'MANUAL_REVIEW') {
      return {
        kind: 'INVALID_TRANSITION',
        reason: `Cannot resolve withdrawal in status ${ctx.status}; MANUAL_REVIEW required`,
      };
    }
    return event.outcome === 'SUCCEEDED'
      ? { kind: 'SETTLE' }
      : { kind: 'FAIL_AND_RELEASE', markTerminalReturn: false };
  }

  // event.kind === 'PROVIDER_STATUS'
  const providerStatus = event.status;
  if (providerStatus === 'PENDING' || providerStatus === 'PROCESSING') {
    return ctx.status === 'DISPATCHING'
      ? { kind: 'ADVANCE_TO_PROCESSING' }
      : { kind: 'NOOP' };
  }

  if (providerStatus === 'SUCCEEDED') {
    if (ctx.status === 'SUCCEEDED') {
      return { kind: 'NOOP' };
    }
    if (ctx.status === 'FAILED') {
      if (
        ctx.failureReason === 'CANCELLED_BY_USER' ||
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

  if (providerStatus === 'FAILED') {
    if (INFLIGHT_STATUSES.has(ctx.status)) {
      return { kind: 'FAIL_AND_RELEASE', markTerminalReturn: false };
    }
    return { kind: 'NOOP' };
  }

  // RETURNED | REVERSED
  if (ctx.status === 'SUCCEEDED') {
    return { kind: 'REVERSE_SUCCEEDED' };
  }
  if (INFLIGHT_STATUSES.has(ctx.status)) {
    return { kind: 'FAIL_AND_RELEASE', markTerminalReturn: true };
  }
  if (ctx.status === 'FAILED' && !ctx.terminalReturn) {
    return { kind: 'MARK_TERMINAL_RETURN_ONLY' };
  }
  return { kind: 'NOOP' };
}
