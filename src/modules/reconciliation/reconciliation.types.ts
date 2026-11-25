export interface ReconciliationLocalDeposit {
  id: string;
  pspRefId: string | null;
  verifiedAmount: string | null;
  onSettlementDate: boolean;
  verifiedAt: Date | null;
}
