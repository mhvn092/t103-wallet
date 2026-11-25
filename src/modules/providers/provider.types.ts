import {
  PayoutStatusValueEnum,
  PspStatusValueEnum,
} from '../../common/enums/provider.enums.js';

export type PspPaymentStatusResult =
  | {
      kind: 'FOUND';
      status: PspStatusValueEnum;
      amountIrt: bigint | null;
      refId: string | null;
      orderId?: string | null;
    }
  | { kind: 'AMBIGUOUS'; reason: string };

export type PspVerifyResult =
  | {
      kind: 'VERIFIED';
      amountIrt: bigint;
      refId: string | null;
      hasIrrRemainder?: boolean;
    }
  | { kind: 'INVALID_VERIFIED_AMOUNT'; reportedAmount: string | null }
  | { kind: 'FAILED'; reason: string }
  | { kind: 'RETRYABLE_ERROR'; reason: string };

export type PayoutCreateResult =
  | { kind: 'ACCEPTED'; trackingId: string }
  | { kind: 'PERMANENT_REJECTED'; reason: string }
  | { kind: 'AMBIGUOUS'; reason: string };

export type PayoutTransferStatusResult =
  | {
      kind: 'FOUND';
      status: PayoutStatusValueEnum;
      providerRefId: string | null;
      failureReason: string | null;
      amount?: string | number | null;
      currency?: string | null;
    }
  | { kind: 'NOT_FOUND' }
  | { kind: 'AMBIGUOUS'; reason: string };
