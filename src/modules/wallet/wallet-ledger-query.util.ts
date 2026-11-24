export const WALLET_ACCOUNT_FILTERS = [
  'AVAILABLE',
  'LOCKED',
  'RECEIVABLE',
  'ALL',
] as const;

export const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;

export function isValidPositiveBigIntCursor(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    return false;
  }
  return BigInt(value) <= MAX_PG_BIGINT;
}

export function parseStrictLimit(value: unknown): number {
  if (value === undefined || value === '') {
    return 20;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      return Number(trimmed);
    }
  }
  return Number.NaN;
}
