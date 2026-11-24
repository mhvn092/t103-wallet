import type {
  CsvDepositRecord,
  ParsedSettlementCsv,
} from './settlement-csv.types.js';

function toAsciiDigits(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0x06f0 && code <= 0x06f9) {
      out += String.fromCodePoint(code - 0x06f0 + 48);
    } else if (code !== undefined && code >= 0x0660 && code <= 0x0669) {
      out += String.fromCodePoint(code - 0x0660 + 48);
    } else {
      out += ch;
    }
  }
  return out;
}

export function normalizeSettlementReference(raw: string): string {
  const ascii = toAsciiDigits(raw).trim();
  if (!ascii) {
    return '';
  }
  return ascii.replace(/^0+(?=.)/, '');
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function parseIrrInteger(raw: string): bigint | null {
  const ascii = toAsciiDigits(raw)
    .replaceAll('\u066C', '') // Persian thousands separator
    .replaceAll('\u060C', '') // Arabic comma
    .replaceAll(',', '')
    .replaceAll(/\s+/g, '')
    .trim();

  if (!/^-?\d+$/.test(ascii)) {
    return null;
  }
  return BigInt(ascii);
}

export function parseSettlementCsv(csvText: string): ParsedSettlementCsv {
  const cleaned = csvText.replace(/^\uFEFF/, '');
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length <= 1) {
    return { deposits: [], ignoredRowCount: 0, duplicateCount: 0 };
  }

  const seenKeys = new Set<string>();
  const deposits: CsvDepositRecord[] = [];
  let ignoredRowCount = 0;
  let duplicateCount = 0;

  for (let idx = 1; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (!line) {
      continue;
    }
    const cols = parseCsvLine(line);
    if (cols.length < 5) {
      ignoredRowCount += 1;
      continue;
    }

    const rowNumber = toAsciiDigits(cols[0] ?? '').trim();
    const persianDate = toAsciiDigits(cols[1] ?? '').trim();
    const rawReference = (cols[2] ?? '').trim();
    const normalizedReference = normalizeSettlementReference(rawReference);
    const txType = (cols[3] ?? '').trim();
    const amountIrr = parseIrrInteger(cols[4] ?? '');
    const description = (cols[5] ?? '').trim();

    if (!normalizedReference || amountIrr === null) {
      ignoredRowCount += 1;
      continue;
    }

    const dedupKey = `${normalizedReference}|${txType}|${amountIrr.toString()}`;
    if (seenKeys.has(dedupKey)) {
      duplicateCount += 1;
      continue;
    }
    seenKeys.add(dedupKey);

    if (txType !== 'واریز درگاه') {
      ignoredRowCount += 1;
      continue;
    }

    const absIrr = amountIrr < 0n ? -amountIrr : amountIrr;
    deposits.push({
      rowNumber,
      persianDate,
      rawReference,
      normalizedReference,
      amountIrr,
      amountIrt: amountIrr / 10n,
      hasIrrRemainder: absIrr % 10n !== 0n,
      description,
    });
  }

  return { deposits, ignoredRowCount, duplicateCount };
}
