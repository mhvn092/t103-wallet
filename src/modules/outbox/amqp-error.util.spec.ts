import { describe, expect, it } from 'vitest';
import { sanitizeBrokerError } from './amqp-error.util.js';

describe('sanitizeBrokerError', () => {
  it('redacts broker credentials in errors and string values', () => {
    expect(
      sanitizeBrokerError(new Error('failed amqp://user:pass@host/vhost now')),
    ).toBe('failed [REDACTED_AMQP_URI] now');
    expect(sanitizeBrokerError('amqps://host/path')).toBe(
      '[REDACTED_AMQP_URI]',
    );
    expect(sanitizeBrokerError({ code: 'EPIPE' })).toBe('[object Object]');
  });
});
