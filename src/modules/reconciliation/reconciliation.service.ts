import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { formatMinorToApi } from '../../common/utils/money.js';
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
    private readonly _database: DatabaseService,
    private readonly _pspClient: PspClient,
  ) {}

  async runReconciliation(date: string): Promise<ReconciliationResponseDto> {
    const validDate = assertValidCalendarDate(date);
    const csvText = await this._pspClient.fetchSettlementCsv(validDate);
    const parsedCsv = parseSettlementCsv(csvText);

    const localForDate =
      await this._findLocalSucceededDepositsForDate(validDate);
    const candidatePool = await this._findLocalSucceededAroundDate(validDate);

    const csvByRef = new Map<string, CsvDepositRecord[]>();
    for (const row of parsedCsv.deposits) {
      const list = csvByRef.get(row.normalizedReference) ?? [];
      list.push(row);
      csvByRef.set(row.normalizedReference, list);
    }

    const localByRef = this._groupDepositsByNormalizedRef(candidatePool);
    const mismatches: ReconciliationMismatchDto[] = [];
    let matchedCount = 0;

    for (const csvRow of parsedCsv.deposits) {
      const result = this._reconcileCsvRow(csvRow, localByRef);
      if (result.matched) {
        matchedCount += 1;
      }
      if (result.mismatch) {
        mismatches.push(result.mismatch);
      }
    }

    for (const local of localForDate) {
      const mismatch = this._checkMissingInCsv(local, csvByRef);
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

  private async _findLocalSucceededDepositsForDate(
    dateStr: string,
  ): Promise<DepositRow[]> {
    return this._database.db
      .select()
      .from(deposits)
      .where(
        sql`${deposits.status} = 'SUCCEEDED' AND (${deposits.verifiedAt} AT TIME ZONE 'UTC')::date = ${dateStr}::date`,
      );
  }

  private async _findLocalSucceededAroundDate(
    dateStr: string,
  ): Promise<DepositRow[]> {
    return this._database.db
      .select()
      .from(deposits)
      .where(
        sql`${deposits.status} = 'SUCCEEDED' AND (${deposits.verifiedAt} AT TIME ZONE 'UTC')::date BETWEEN (${dateStr}::date - INTERVAL '1 day') AND (${dateStr}::date + INTERVAL '1 day')`,
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

  private _reconcileCsvRow(
    csvRow: CsvDepositRecord,
    localByRef: Map<string, DepositRow[]>,
  ): { matched: boolean; mismatch?: ReconciliationMismatchDto } {
    const candidates = localByRef.get(csvRow.normalizedReference);
    const match = candidates?.[0];
    if (!match) {
      return {
        matched: false,
        mismatch: {
          type: 'MISSING_IN_LOCAL',
          reference: csvRow.normalizedReference,
          csvAmount: formatMinorToApi(csvRow.amountIrt, 'IRT'),
          localAmount: null,
          depositId: null,
          details: `PSP settlement row present in CSV (${csvRow.description}) but missing in local SUCCEEDED deposits`,
        },
      };
    }

    const localIrt =
      match.verifiedAmount !== null ? BigInt(match.verifiedAmount) : 0n;

    if (csvRow.hasIrrRemainder || csvRow.amountIrt !== localIrt) {
      return {
        matched: false,
        mismatch: {
          type: 'AMOUNT_MISMATCH',
          reference: csvRow.normalizedReference,
          csvAmount: formatMinorToApi(csvRow.amountIrt, 'IRT'),
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
    csvByRef: Map<string, CsvDepositRecord[]>,
  ): ReconciliationMismatchDto | undefined {
    const normRef = local.pspRefId
      ? normalizeSettlementReference(local.pspRefId)
      : '';
    if (normRef && csvByRef.has(normRef)) {
      return undefined;
    }

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
