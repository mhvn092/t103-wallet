import { createHash, timingSafeEqual } from 'node:crypto';

export function matchesSecret(
  expected: string,
  supplied: string | undefined,
): boolean {
  if (supplied === undefined) {
    return false;
  }
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(supplied).digest(),
  );
}
