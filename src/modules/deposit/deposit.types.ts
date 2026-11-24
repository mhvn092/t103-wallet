import type { deposits } from '../../database/schema/index.js';

export type DepositEntity = typeof deposits.$inferSelect;
