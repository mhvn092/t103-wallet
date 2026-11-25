import { describe, expect, it, vi } from 'vitest';
import {
  addJitterMs,
  addPositiveJitterMs,
  computeJitteredBackoffMs,
  computeSafeLeaseMs,
} from './backoff.util.js';

describe('backoff utilities', () => {
  it('clamps spread and generated jitter to expected bounds', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(addJitterMs(1_000, 2)).toBe(500);
    expect(addJitterMs(1_000, -1)).toBe(1_000);
    expect(addPositiveJitterMs(1_000, 0.5)).toBe(1_000);
    expect(addJitterMs(0)).toBe(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(addPositiveJitterMs(1_000, 0.5)).toBe(1_500);
    vi.restoreAllMocks();
  });

  it('builds safe leases and caps exponential retries', () => {
    expect(computeSafeLeaseMs(10_000, 2_000, 3)).toBe(16_000);
    expect(computeSafeLeaseMs(20_000, 2_000, 0, 0)).toBe(20_000);
    expect(computeJitteredBackoffMs(0, 1_000, 5_000)).toBeGreaterThanOrEqual(
      800,
    );
    expect(computeJitteredBackoffMs(20, 1_000, 5_000)).toBeLessThanOrEqual(
      6_000,
    );
  });
});
