export function addJitterMs(baseMs: number, spreadRatio = 0.2): number {
  const safeBase = Math.max(0, baseMs);
  if (safeBase === 0) {
    return 0;
  }
  const safeSpread = Math.min(0.5, Math.max(0, spreadRatio));
  const multiplier = 1 - safeSpread + Math.random() * safeSpread * 2;
  return Math.max(100, Math.round(safeBase * multiplier));
}

export function computeJitteredBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const clampedAttempt = Math.max(1, Math.trunc(attempt));
  const expDelay = Math.min(maxMs, baseMs * 2 ** (clampedAttempt - 1));
  return addJitterMs(expDelay, 0.2);
}

