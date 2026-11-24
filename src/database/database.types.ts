import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

export type AppDatabase = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<
  Parameters<AppDatabase['transaction']>[0]
>[0];
export type DbExecutor = AppDatabase | DbTransaction;
