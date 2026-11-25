import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface RequestContextStoreInterface {
  requestId: string;
}

const requestContextStorage =
  new AsyncLocalStorage<RequestContextStoreInterface>();
const SAFE_REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveCorrelationId(rawHeader?: string): string {
  const trimmed = rawHeader?.trim();
  if (trimmed && SAFE_REQUEST_ID_REGEX.test(trimmed)) {
    return trimmed;
  }
  return randomUUID();
}

export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run({ requestId }, fn);
}

export function getCorrelationId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
