import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const prop = record[key];
    if (prop !== undefined) {
      sorted[key] = canonicalize(prop);
    }
  }
  return sorted;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(value), 'utf8')
    .digest('hex');
}
