import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as accountsSchema from './schema/accounts.schema.js';
import type * as ledgerSchema from './schema/ledger.schema.js';
import type * as operationsSchema from './schema/operations.schema.js';
import type * as enumSchema from './schema/pg-enums.schema.js';

export type AppDatabase = NodePgDatabase<
  typeof accountsSchema &
    typeof ledgerSchema &
    typeof operationsSchema &
    typeof enumSchema
>;
export type DbTransaction = Parameters<
  Parameters<AppDatabase['transaction']>[0]
>[0];
export type DbExecutor = AppDatabase | DbTransaction;
