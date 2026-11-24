import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const sorted: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (prop !== undefined) {
      sorted[key] = canonicalize(prop);
    }
  }
  return sorted;
}

export function sha256CanonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value)) ?? 'null';
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
