import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { Currency } from './money.util.js';

const IR_IBAN_REGEX = /^IR\d{24}$/;
const TRC20_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, bigint>(
  BASE58_ALPHABET.split('').map((ch, idx) => [ch, BigInt(idx)]),
);

export function isValidIranianIban(iban: string): boolean {
  const normalized = iban.trim().toUpperCase();
  if (!IR_IBAN_REGEX.test(normalized)) {
    return false;
  }

  // ISO-13616: move first 4 chars to end, map A=10..Z=35, mod 97 == 1
  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      const val = code - 55; // A=10 .. Z=35
      remainder = (remainder * 10 + Math.floor(val / 10)) % 97;
      remainder = (remainder * 10 + (val % 10)) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

export function isValidTrc20Address(address: string): boolean {
  const trimmed = address.trim();
  if (!TRC20_REGEX.test(trimmed)) {
    return false;
  }

  let num = 0n;
  for (const ch of trimmed) {
    const digit = BASE58_MAP.get(ch);
    if (digit === undefined) {
      return false;
    }
    num = num * 58n + digit;
  }

  const bytes = Buffer.alloc(25);
  for (let i = 24; i >= 0; i -= 1) {
    bytes[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n || bytes[0] !== 0x41) {
    return false;
  }

  const payload = bytes.subarray(0, 21);
  const checksum = bytes.subarray(21, 25);
  const hash1 = createHash('sha256').update(payload).digest();
  const hash2 = createHash('sha256').update(hash1).digest();
  return checksum.equals(hash2.subarray(0, 4));
}

export function assertValidDestination(
  destination: string,
  currency: Currency,
): string {
  const trimmed = destination.trim();
  if (currency === 'IRT') {
    const upper = trimmed.toUpperCase();
    if (!isValidIranianIban(upper)) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_DESTINATION,
        'Destination must be a valid Iranian IBAN (IR followed by 24 digits)',
      );
    }
    return upper;
  }

  if (!isValidTrc20Address(trimmed)) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_DESTINATION,
      'Destination must be a valid Base58Check TRC20 address starting with T',
    );
  }
  return trimmed;
}
