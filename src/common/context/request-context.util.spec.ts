import { describe, expect, it } from 'vitest';
import {
  getCorrelationId,
  resolveCorrelationId,
  runWithRequestContext,
} from './request-context.util.js';

describe('request context', () => {
  it('accepts safe trimmed request ids and replaces unsafe headers', () => {
    expect(resolveCorrelationId(' req_1-ABC.2 ')).toBe('req_1-ABC.2');
    for (const value of ['', 'bad id', 'x'.repeat(129), 'id/with/slash']) {
      expect(resolveCorrelationId(value)).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(resolveCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('isolates context to the callback', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(runWithRequestContext('req-a', () => getCorrelationId())).toBe(
      'req-a',
    );
    expect(getCorrelationId()).toBeUndefined();
  });
});
