type PspStatusValue = 'INIT' | 'PAID' | 'VERIFIED' | 'FAILED' | 'EXPIRED';

export type PspPaymentStatusResult =
  | {
      kind: 'FOUND';
      status: PspStatusValue;
      amountIrt: bigint | null;
      refId: string | null;
    }
  | { kind: 'AMBIGUOUS'; reason: string };

export type PspVerifyResult =
  | { kind: 'VERIFIED'; amountIrt: bigint; refId: string | null }
  | { kind: 'FAILED'; reason: string }
  | { kind: 'RETRYABLE_ERROR'; reason: string };

export type PayoutCreateResult =
  | { kind: 'ACCEPTED'; trackingId: string }
  | { kind: 'PERMANENT_REJECTED'; reason: string }
  | { kind: 'AMBIGUOUS'; reason: string };

export type PayoutStatusValue =
  'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'RETURNED' | 'REVERSED';

export type PayoutTransferStatusResult =
  | {
      kind: 'FOUND';
      status: PayoutStatusValue;
      providerRefId: string | null;
      failureReason: string | null;
    }
  | { kind: 'NOT_FOUND' }
  | { kind: 'AMBIGUOUS'; reason: string };
