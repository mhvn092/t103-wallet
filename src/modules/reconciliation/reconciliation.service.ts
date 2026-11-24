import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { formatMinorToApi } from '../../common/utils/money.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import { deposits } from '../../database/schema/index.js';
import { PspClient } from '../providers/psp.client.js';
import type {
  ReconciliationMismatchDto,
  ReconciliationResponseDto,
} from './dto/reconciliation-response.dto.js';
import {
  type CsvDepositRecord,
  normalizeSettlementReference,
  parseSettlementCsv,
} from './settlement-csv.parser.js';

type DepositRow = typeof deposits.$inferSelect;

function formatSignedIrtMinor(minor: bigint): string {
  return minor < 0n
    ? `-${formatMinorToApi(-minor, 'IRT')}`
    : formatMinorToApi(minor, 'IRT');
}

function assertValidCalendarDate(dateStr: string): string {
  const [yStr, mStr, dStr] = dateStr.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new DomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVALID_REQUEST,
      `Invalid calendar date: ${dateStr}`,
    );
  }
  return dateStr;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly _config: ConfigService<EnvConfig, true>,
    private readonly _database: DatabaseService,
    private readonly _pspClient: PspClient,
  ) {}

  async runReconciliation(date: string): Promise<ReconciliationResponseDto> {
    const validDate = assertValidCalendarDate(date);
    const csvText = await this._pspClient.fetchSettlementCsv(validDate);
    const parsedCsv = parseSettlementCsv(csvText);

    const localForDate = await this._findSucceededInDateOffsetRange(
      validDate,
      0,
      1,
    );
    const candidatePool = await this._findSucceededInDateOffsetRange(
      validDate,
      -1,
      2,
    );

    const localByRef = this._groupDepositsByNormalizedRef(candidatePool);
    const consumedLocalIds = new Set<string>();
    const mismatches: ReconciliationMismatchDto[] = [];
    let matchedCount = 0;

    for (const csvRow of parsedCsv.deposits) {
      const result = this._reconcileCsvRow(
        csvRow,
        localByRef,
        consumedLocalIds,
      );
      if (result.matched) {
        matchedCount += 1;
      }
      if (result.mismatch) {
        mismatches.push(result.mismatch);
      }
    }

    for (const local of localForDate) {
      const mismatch = this._checkMissingInCsv(local, consumedLocalIds);
      if (mismatch) {
        mismatches.push(mismatch);
      }
    }

    return {
      date: validDate,
      summary: {
        csvDepositCount: parsedCsv.deposits.length,
        localDepositCount: localForDate.length,
        matchedCount,
        mismatchCount: mismatches.length,
        duplicateCsvRowsIgnored: parsedCsv.duplicateCount,
      },
      mismatches,
    };
  }

  private async _findSucceededInDateOffsetRange(
    dateStr: string,
    startOffsetDays: number,
    endOffsetDaysExclusive: number,
  ): Promise<DepositRow[]> {
    const tz = this._config.get('RECONCILIATION_TZ', { infer: true });
    return this._database.db
      .select()
      .from(deposits)
      .where(
        sql`${deposits.status} = 'SUCCEEDED'
          AND ${deposits.verifiedAt} >= ((${dateStr}::date + (${startOffsetDays} * INTERVAL '1 day'))::timestamp AT TIME ZONE ${tz})
          AND ${deposits.verifiedAt} < ((${dateStr}::date + (${endOffsetDaysExclusive} * INTERVAL '1 day'))::timestamp AT TIME ZONE ${tz})`,
      );
  }

  private _groupDepositsByNormalizedRef(
    rows: DepositRow[],
  ): Map<string, DepositRow[]> {
    const map = new Map<string, DepositRow[]>();
    for (const row of rows) {
      if (!row.pspRefId) {
        continue;
      }
      const normRef = normalizeSettlementReference(row.pspRefId);
      if (!normRef) {
        continue;
      }
      const existing = map.get(normRef) ?? [];
      existing.push(row);
      map.set(normRef, existing);
    }
    return map;
  }

  private _consumeMatchingCandidate(
    candidates: DepositRow[] | undefined,
    expectedAmountIrt: bigint,
  ): DepositRow | undefined {
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    const exactIndex = candidates.findIndex(
      (c) => BigInt(c.verifiedAmount ?? '0') === expectedAmountIrt,
    );
    if (exactIndex >= 0) {
      return candidates.splice(exactIndex, 1)[0];
    }
    return candidates.shift();
  }

  private _reconcileCsvRow(
    csvRow: CsvDepositRecord,
    localByRef: Map<string, DepositRow[]>,
    consumedLocalIds: Set<string>,
  ): { matched: boolean; mismatch?: ReconciliationMismatchDto } {
    const candidates = localByRef.get(csvRow.normalizedReference);
    const match = this._consumeMatchingCandidate(candidates, csvRow.amountIrt);

    if (csvRow.amountIrr <= 0n) {
      if (match) {
        consumedLocalIds.add(match.id);
      }
      const localIrt = match ? BigInt(match.verifiedAmount ?? '0') : null;
      return {
        matched: false,
        mismatch: {
          type: 'AMOUNT_MISMATCH',
          reference: csvRow.normalizedReference,
          csvAmount: formatSignedIrtMinor(csvRow.amountIrt),
          localAmount:
            localIrt !== null ? formatMinorToApi(localIrt, 'IRT') : null,
          depositId: match?.id ?? null,
          details: 'PSP settlement CSV deposit row has non-positive IRR amount',
        },
      };
    }

    if (!match) {
      return {
        matched: false,
        mismatch: {
          type: 'MISSING_IN_LOCAL',
          reference: csvRow.normalizedReference,
          csvAmount: formatSignedIrtMinor(csvRow.amountIrt),
          localAmount: null,
          depositId: null,
          details: `PSP settlement row present in CSV (${csvRow.description}) but missing in local SUCCEEDED deposits`,
        },
      };
    }

    consumedLocalIds.add(match.id);
    const localIrt =
      match.verifiedAmount !== null ? BigInt(match.verifiedAmount) : 0n;

    if (csvRow.hasIrrRemainder || csvRow.amountIrt !== localIrt) {
      return {
        matched: false,
        mismatch: {
          type: 'AMOUNT_MISMATCH',
          reference: csvRow.normalizedReference,
          csvAmount: formatSignedIrtMinor(csvRow.amountIrt),
          localAmount: formatMinorToApi(localIrt, 'IRT'),
          depositId: match.id,
          details: csvRow.hasIrrRemainder
            ? 'PSP settlement CSV IRR amount is not an exact multiple of 10'
            : 'PSP settlement CSV IRT amount differs from local verified deposit amount',
        },
      };
    }

    return { matched: true };
  }

  private _checkMissingInCsv(
    local: DepositRow,
    consumedLocalIds: Set<string>,
  ): ReconciliationMismatchDto | undefined {
    if (consumedLocalIds.has(local.id)) {
      return undefined;
    }

    const normRef = local.pspRefId
      ? normalizeSettlementReference(local.pspRefId)
      : '';
    const localIrt =
      local.verifiedAmount !== null ? BigInt(local.verifiedAmount) : 0n;
    return {
      type: 'MISSING_IN_CSV',
      reference: normRef || local.id,
      csvAmount: null,
      localAmount: formatMinorToApi(localIrt, 'IRT'),
      depositId: local.id,
      details:
        'Local SUCCEEDED deposit on target date not found in PSP settlement CSV',
    };
  }
}
