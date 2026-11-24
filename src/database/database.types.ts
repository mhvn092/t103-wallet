import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

export type AppDatabase = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
export type DbExecutor = AppDatabase | DbTransaction;

export function isPgErrorCode(error: unknown, targetCode: string): boolean {
  for (
    let curr = error as { code?: unknown; cause?: unknown } | undefined;
    curr && typeof curr === 'object';
    curr = curr.cause as { code?: unknown; cause?: unknown } | undefined
  ) {
    if (curr.code === targetCode) {
      return true;
    }
  }
  return false;
}
