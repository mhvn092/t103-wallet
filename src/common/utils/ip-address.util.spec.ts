import { describe, expect, it } from 'vitest';
import { normalizeIpAddress } from './ip-address.util.js';

describe('normalizeIpAddress', () => {
  it('normalizes mapped IPv4 and handles missing or native addresses', () => {
    expect(normalizeIpAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIpAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIpAddress(undefined)).toBe('');
  });
});
