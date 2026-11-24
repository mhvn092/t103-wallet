function applyJitter(
  baseMs: number,
  minMultiplier: number,
  maxMultiplier: number,
  minResultMs: number,
): number {
  const safeBase = Math.max(0, baseMs);
  if (safeBase === 0) {
    return 0;
  }
  const multiplier =
    minMultiplier + Math.random() * Math.max(0, maxMultiplier - minMultiplier);
  return Math.max(minResultMs, Math.round(safeBase * multiplier));
}

export function addJitterMs(baseMs: number, spreadRatio = 0.2): number {
  const safeSpread = Math.min(0.5, Math.max(0, spreadRatio));
  return applyJitter(baseMs, 1 - safeSpread, 1 + safeSpread, 100);
}

export function addPositiveJitterMs(baseMs: number, spreadRatio = 0.2): number {
  const safeSpread = Math.min(0.5, Math.max(0, spreadRatio));
  return applyJitter(baseMs, 1, 1 + safeSpread, 0);
}

export function computeSafeLeaseMs(
  baseLeaseMs: number,
  providerTimeoutMs: number,
  httpHops: number,
  bufferMs = 10_000,
): number {
  const hops = Math.max(1, Math.trunc(httpHops));
  return Math.max(baseLeaseMs, providerTimeoutMs * hops + bufferMs);
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
