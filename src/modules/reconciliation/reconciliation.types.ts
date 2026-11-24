export interface ReconciliationLocalDeposit {
  id: string;
  pspRefId: string | null;
  verifiedAmount: string | null;
  verifiedAt: Date | null;
}
