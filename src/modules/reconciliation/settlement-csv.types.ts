export interface CsvDepositRecord {
  rowNumber: string;
  persianDate: string;
  rawReference: string;
  normalizedReference: string;
  amountIrr: bigint;
  amountIrt: bigint;
  hasIrrRemainder: boolean;
  description: string;
}

export interface ParsedSettlementCsv {
  deposits: CsvDepositRecord[];
  ignoredRowCount: number;
  duplicateCount: number;
}
