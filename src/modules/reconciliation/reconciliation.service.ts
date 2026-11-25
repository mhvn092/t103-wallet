import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, isNull, sql } from 'drizzle-orm';
import { formatMinorToApi } from '../../common/utils/money.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DbTransaction } from '../../database/database.types.js';
import { deposits } from '../../database/schema/index.js';
import { PspClient } from '../providers/psp.client.js';
import type {
  ReconciliationAdjacentDayMatchDto,
  ReconciliationMismatchDto,
  ReconciliationResponseDto,
} from './dto/reconciliation-response.dto.js';
import {
  assertValidCalendarDate,
  formatSignedIrtMinor,
} from './reconciliation-date.util.js';
import type { ReconciliationLocalDeposit } from './reconciliation.types.js';
import {
  normalizeSettlementReference,
  parseSettlementCsv,
} from './settlement-csv.parser.js';
import type { CsvDepositRecord } from './settlement-csv.types.js';

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _databaseService: DatabaseService,
    private readonly _pspClient: PspClient,
  ) {}

  async runReconciliation(date: string): Promise<ReconciliationResponseDto> {
    const validDate = assertValidCalendarDate(date);
    const csvText = await this._pspClient.fetchSettlementCsv(validDate);
    const parsedCsv = parseSettlementCsv(csvText);

    return this._databaseService.runInTransaction(async (tx) => {
      // A provider reference must not match two different daily settlement reports.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(840104)`);
      return this._reconcileSettlements(tx, validDate, parsedCsv);
    });
  }

  private async _reconcileSettlements(
    tx: DbTransaction,
    validDate: string,
    parsedCsv: ReturnType<typeof parseSettlementCsv>,
  ): Promise<ReconciliationResponseDto> {
    const candidatePool = await this._findSettlementCandidates(tx, validDate);
    const localForDate = candidatePool.filter((row) => row.onSettlementDate);
    const localForDateIds = new Set(localForDate.map((row) => row.id));
    const localByRef = this._groupDepositsByNormalizedRef(candidatePool);
    const consumedLocalIds = new Set<string>();
    const matchedDepositIds = [];
    const mismatches: ReconciliationMismatchDto[] = [];
    const adjacentDayMatches: ReconciliationAdjacentDayMatchDto[] = [];
    let matchedCount = 0;
    let adjacentDayMatchedCount = 0;

    for (const csvRow of parsedCsv.deposits) {
      const result = this._reconcileCsvRow(
        csvRow,
        localByRef,
        consumedLocalIds,
        localForDateIds,
      );
      if (result.matchedDepositId) {
        matchedCount += 1;
        matchedDepositIds.push(result.matchedDepositId);
      }
      if (result.adjacentMatch) {
        adjacentDayMatchedCount += 1;
        adjacentDayMatches.push(result.adjacentMatch);
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

    if (matchedDepositIds.length > 0) {
      await tx
        .update(deposits)
        .set({ reconciledSettlementDate: validDate })
        .where(
          and(
            isNull(deposits.reconciledSettlementDate),
            sql`${deposits.id} IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(matchedDepositIds)}::jsonb))`,
          ),
        );
    }

    return {
      date: validDate,
      summary: {
        csvDepositCount: parsedCsv.deposits.length,
        localDepositCount: localForDate.length,
        matchedCount,
        adjacentDayMatchedCount,
        mismatchCount: mismatches.length,
        duplicateCsvRowsIgnored: parsedCsv.duplicateCount,
      },
      mismatches,
      adjacentDayMatches,
    };
  }

  private async _findSettlementCandidates(
    tx: DbTransaction,
    dateStr: string,
  ): Promise<ReconciliationLocalDeposit[]> {
    const tz = this._configService.get('RECONCILIATION_TZ', { infer: true });
    const start = sql`(${dateStr}::date::timestamp AT TIME ZONE ${tz})`;
    const end = sql`((${dateStr}::date + 1)::timestamp AT TIME ZONE ${tz})`;
    return tx
      .select({
        id: deposits.id,
        pspRefId: deposits.pspRefId,
        verifiedAmount: deposits.verifiedAmount,
        verifiedAt: deposits.verifiedAt,
        onSettlementDate: sql<boolean>`${deposits.verifiedAt} >= ${start} AND ${deposits.verifiedAt} < ${end}`,
      })
      .from(deposits)
      .where(
        sql`${deposits.status} = 'SUCCEEDED'
          AND (${deposits.reconciledSettlementDate} IS NULL OR ${deposits.reconciledSettlementDate} = ${dateStr}::date)
          AND ${deposits.verifiedAt} >= ${start} - INTERVAL '15 minutes'
          AND ${deposits.verifiedAt} < ${end} + INTERVAL '15 minutes'`,
      )
      .orderBy(deposits.verifiedAt, deposits.id);
  }

  private _groupDepositsByNormalizedRef(
    rows: ReconciliationLocalDeposit[],
  ): Map<string, ReconciliationLocalDeposit[]> {
    const map = new Map<string, ReconciliationLocalDeposit[]>();
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
    candidates: ReconciliationLocalDeposit[] | undefined,
    expectedAmountIrt: bigint,
    localForDateIds: ReadonlySet<string>,
  ): ReconciliationLocalDeposit | undefined {
    if (!candidates || candidates.length === 0) {
      return undefined;
    }

    // Prefer exact-amount same-day matches first, then exact-amount adjacent-day, then same-day, then FIFO
    const exactSameDay = candidates.findIndex(
      (c) =>
        localForDateIds.has(c.id) &&
        BigInt(c.verifiedAmount ?? '0') === expectedAmountIrt,
    );
    if (exactSameDay >= 0) {
      return candidates.splice(exactSameDay, 1)[0];
    }

    const exactAnyDay = candidates.findIndex(
      (c) => BigInt(c.verifiedAmount ?? '0') === expectedAmountIrt,
    );
    if (exactAnyDay >= 0) {
      return candidates.splice(exactAnyDay, 1)[0];
    }

    const sameDay = candidates.findIndex((c) => localForDateIds.has(c.id));
    if (sameDay >= 0) {
      return candidates.splice(sameDay, 1)[0];
    }

    return candidates.shift();
  }

  private _reconcileCsvRow(
    csvRow: CsvDepositRecord,
    localByRef: Map<string, ReconciliationLocalDeposit[]>,
    consumedLocalIds: Set<string>,
    localForDateIds: ReadonlySet<string>,
  ): {
    matchedDepositId?: string;
    adjacentMatch?: ReconciliationAdjacentDayMatchDto;
    mismatch?: ReconciliationMismatchDto;
  } {
    const candidates = localByRef.get(csvRow.normalizedReference);
    const match = this._consumeMatchingCandidate(
      candidates,
      csvRow.amountIrt,
      localForDateIds,
    );

    if (csvRow.amountIrr <= 0n) {
      if (match) {
        consumedLocalIds.add(match.id);
      }
      const localIrt = match ? BigInt(match.verifiedAmount ?? '0') : null;
      return {
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
        mismatch: {
          type: 'MISSING_IN_LOCAL',
          reference: csvRow.normalizedReference,
          csvAmount: formatSignedIrtMinor(csvRow.amountIrt),
          localAmount: null,
          depositId: null,
          details: `PSP settlement row present in CSV (${csvRow.description}) but missing from unmatched local SUCCEEDED deposits for this date`,
        },
      };
    }

    consumedLocalIds.add(match.id);
    const localIrt =
      match.verifiedAmount !== null ? BigInt(match.verifiedAmount) : 0n;

    if (csvRow.hasIrrRemainder || csvRow.amountIrt !== localIrt) {
      return {
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

    if (!localForDateIds.has(match.id)) {
      const formattedAmount = formatMinorToApi(localIrt, 'IRT');
      return {
        matchedDepositId: match.id,
        adjacentMatch: {
          type: 'MATCHED_ADJACENT_DAY',
          reference: csvRow.normalizedReference,
          csvAmount: formatSignedIrtMinor(csvRow.amountIrt),
          localAmount: formattedAmount,
          depositId: match.id,
          verifiedAt: match.verifiedAt ? match.verifiedAt.toISOString() : null,
          details:
            'CSV settlement row matched a SUCCEEDED deposit verified on an adjacent day within 15 minutes of the settlement cutoff',
        },
      };
    }

    return { matchedDepositId: match.id };
  }

  private _checkMissingInCsv(
    local: ReconciliationLocalDeposit,
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
