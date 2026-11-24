import { addJitterMs } from '../../common/utils/backoff.util.js';
import type { DepositEntity } from './deposit.types.js';
import type { DepositDetailResponseDto } from './dto/deposit-response.dto.js';

export function toDepositDetailResponseDto(
  row: DepositEntity,
): DepositDetailResponseDto {
  return {
    depositId: row.id,
    userId: row.userId,
    requestedAmount: row.requestedAmount,
    verifiedAmount: row.verifiedAmount,
    amountMismatch: row.amountMismatch,
    pspToken: row.pspToken,
    pspRefId: row.pspRefId,
    paymentUrl: row.paymentUrl,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function computePostExpiryGracePollAt(
  expiresAt: Date,
  nowMs: number,
  graceMs: number,
): Date | null {
  if (graceMs <= 0) {
    return null;
  }
  const graceDeadlineMs = expiresAt.getTime() + graceMs;
  if (nowMs >= graceDeadlineMs) {
    return null;
  }
  const elapsedMs = nowMs - expiresAt.getTime();
  let stepBaseMs = 300_000;
  if (elapsedMs < 120_000) {
    stepBaseMs = 30_000;
  } else if (elapsedMs < 300_000) {
    stepBaseMs = 120_000;
  }
  return new Date(Math.min(graceDeadlineMs, nowMs + addJitterMs(stepBaseMs)));
}
