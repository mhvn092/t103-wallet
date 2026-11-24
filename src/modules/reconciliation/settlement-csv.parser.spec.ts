import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  normalizeSettlementReference,
  parseSettlementCsv,
} from './settlement-csv.parser.js';

function toPersianDigits(input: string): string {
  return input.replace(/\d/g, (d) => String.fromCodePoint(0x06f0 + Number(d)));
}

describe('settlement-csv.parser', () => {
  it('normalizes dirty Persian simulator CSVs with Persian digits, separators, leading zeros, duplicates, and mixed tx types', () => {
    const sampleCsv = [
      'ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح',
      '1,۱۴۰۵/۰۹/۰۳,0001382264189,واریز درگاه,"۵۰۰٬۰۰۰",پرداخت اینترنتی A0e446df4620bb6a73',
      '2,1405/09/03, 4929073756 ,واریز درگاه,"510,000",پرداخت اینترنتی A00a6998e75ec01778',
      '3,1405/09/03,4619725313,واریز درگاه,"۵۲۰٬۰۰۰",پرداخت اینترنتی A004204f35e048b3db',
      '3,1405/09/03,4619725313,واریز درگاه,"۵۲۰٬۰۰۰",پرداخت اینترنتی A004204f35e048b3db',
      '8,1405/09/03, TRK0a29ff53fa92a12e ,برداشت پایا,"-1,500,000",انتقال به IR062960000000100324200001',
      '9,۱۴۰۵/۰۹/۰۳,TRK0a29ff53fa92a12e,کارمزد,"-۲٬۵۰۰",کارمزد انتقال پایا',
      '10,1405/09/03,0006944051731,واریز درگاه,"3,100,000",پرداخت اینترنتی نامشخص',
    ].join('\r\n');

    const parsed = parseSettlementCsv(`\uFEFF${sampleCsv}`);

    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.ignoredRowCount).toBe(2);
    expect(parsed.deposits).toHaveLength(4);
    expect(parsed.deposits[0]).toMatchObject({
      normalizedReference: '1382264189',
      amountIrr: 500_000n,
      amountIrt: 50_000n,
      hasIrrRemainder: false,
    });
    expect(parsed.deposits[1]?.normalizedReference).toBe('4929073756');
    expect(parsed.deposits[1]?.amountIrt).toBe(51_000n);
    expect(parsed.deposits[2]?.amountIrt).toBe(52_000n);
    expect(parsed.deposits[3]?.normalizedReference).toBe('6944051731');
    expect(parsed.deposits[3]?.amountIrt).toBe(310_000n);
  });

  it('preserves leading-zero stripping idempotence and Persian/ASCII IRR->IRT arithmetic across arbitrary values', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[1-9]\d{4,12}$/),
        fc.integer({ min: 0, max: 5 }),
        fc.bigInt({ min: 1n, max: 10n ** 11n }),
        (coreRef, zeroPad, irtAmount) => {
          const padded = `  ${'0'.repeat(zeroPad)}${coreRef}  `;
          const norm = normalizeSettlementReference(padded);
          expect(norm).toBe(coreRef);
          expect(normalizeSettlementReference(norm)).toBe(norm);

          const irr = irtAmount * 10n;
          const persianFormatted = toPersianDigits(
            irr.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','),
          ).replaceAll(',', '٬');
          const csv = `ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح\n1,1405/09/03,${'0'.repeat(zeroPad)}${coreRef},واریز درگاه,"${persianFormatted}",test`;
          const parsed = parseSettlementCsv(csv);
          expect(parsed.deposits).toHaveLength(1);
          expect(parsed.deposits[0]?.normalizedReference).toBe(coreRef);
          expect(parsed.deposits[0]?.amountIrt).toBe(irtAmount);
          expect(parsed.deposits[0]?.hasIrrRemainder).toBe(false);
        },
      ),
    );
  });
});
