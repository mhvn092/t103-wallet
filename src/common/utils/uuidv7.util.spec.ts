import { describe, expect, it } from 'vitest';
import { uuidV7LowerBoundForMs } from './uuidv7.util.js';

describe('uuidV7LowerBoundForMs', () => {
  it('encodes the timestamp and UUIDv7 version/variant bits', () => {
    expect(uuidV7LowerBoundForMs(1_700_000_000_123)).toBe(
      '018bcfe5-687b-7000-8000-000000000000',
    );
    expect(uuidV7LowerBoundForMs(-3)).toBe(
      '00000000-0000-7000-8000-000000000000',
    );
  });
});
