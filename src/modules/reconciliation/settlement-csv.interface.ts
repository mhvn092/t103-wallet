export interface CsvDepositRecordInterface {
  rowNumber: string;
  persianDate: string;
  rawReference: string;
  normalizedReference: string;
  amountIrr: bigint;
  amountIrt: bigint;
  hasIrrRemainder: boolean;
  description: string;
}

export interface ParsedSettlementCsvInterface {
  deposits: CsvDepositRecordInterface[];
  ignoredRowCount: number;
  duplicateCount: number;
}
