import type { deposits } from '../../database/schema/operations.schema.js';

export type DepositEntity = typeof deposits.$inferSelect;
