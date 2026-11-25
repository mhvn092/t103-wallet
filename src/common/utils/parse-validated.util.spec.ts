import { describe, expect, it } from 'vitest';
import { PayoutStatusValueEnum } from '../enums/provider.enums.js';
import { PspCallbackPayloadDto } from '../../modules/deposit/deposit.schemas.js';
import { PayoutInquiryDto } from '../../modules/providers/payout.schemas.js';
import { parseValidated } from './parse-validated.util.js';

describe('provider payload validation', () => {
  it('accepts nullable optional fields, both amount formats, and strips unknown fields', () => {
    for (const amount of ['1500000.00', 1500000]) {
      const result = parseValidated(PayoutInquiryDto, {
        status: PayoutStatusValueEnum.SUCCEEDED,
        amount,
        refId: null,
        unknown: 'ignored',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(amount);
        expect(result.data.refId).toBeNull();
        expect(result.data).not.toHaveProperty('unknown');
      }
    }
  });

  it('rejects malformed objects and invalid fields without coercing them', () => {
    for (const payload of [
      null,
      [],
      'text',
      { status: 'INVALID' },
      { status: PayoutStatusValueEnum.SUCCEEDED, amount: true },
    ]) {
      expect(parseValidated(PayoutInquiryDto, payload).success).toBe(false);
    }
    expect(parseValidated(PspCallbackPayloadDto, { token: '' }).success).toBe(
      false,
    );
    expect(parseValidated(PspCallbackPayloadDto, { token: null }).success).toBe(
      true,
    );
  });
});
