import type { withdrawals } from '../../database/schema/operations.schema.js';

export type WithdrawalEntity = typeof withdrawals.$inferSelect;
