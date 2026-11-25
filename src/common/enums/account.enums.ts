export enum AccountOwnerTypeEnum {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

export enum AccountTypeEnum {
  AVAILABLE = 'AVAILABLE',
  LOCKED = 'LOCKED',
  RECEIVABLE = 'RECEIVABLE',
  CLEARING = 'CLEARING',
  ADJUSTMENT = 'ADJUSTMENT',
  REVENUE = 'REVENUE',
}

export enum UserAccountTypeEnum {
  AVAILABLE = 'AVAILABLE',
  LOCKED = 'LOCKED',
  RECEIVABLE = 'RECEIVABLE',
}

export enum WalletAccountFilterEnum {
  AVAILABLE = 'AVAILABLE',
  LOCKED = 'LOCKED',
  RECEIVABLE = 'RECEIVABLE',
  ALL = 'ALL',
}

export enum SystemOwnerIdEnum {
  PSP_CLEARING = 'PSP_CLEARING',
  PAYOUT_CLEARING = 'PAYOUT_CLEARING',
  OPS_ADJUSTMENT = 'OPS_ADJUSTMENT',
  FEE_REVENUE = 'FEE_REVENUE',
}
