import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { EnvConfig } from '../config/env.validation.js';
import type { AppDatabase, DbTransaction } from './database.types.js';
import * as accountsSchema from './schema/accounts.schema.js';
import * as ledgerSchema from './schema/ledger.schema.js';
import * as operationsSchema from './schema/operations.schema.js';
import * as enumSchema from './schema/pg-enums.schema.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly _logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  readonly db: AppDatabase;

  constructor(configService: ConfigService<EnvConfig, true>) {
    this.pool = new Pool({
      connectionString: configService.get('DATABASE_URI', { infer: true }),
      max: 25,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      options:
        '-c lock_timeout=3000 -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
    });
    this.pool.on('error', () => {
      this._logger.warn(
        'PostgreSQL removed an idle pool client after a connection error',
      );
    });
    this.db = drizzle(this.pool, {
      schema: {
        ...accountsSchema,
        ...ledgerSchema,
        ...operationsSchema,
        ...enumSchema,
      },
    });
  }

  async runInTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn, { isolationLevel: 'read committed' });
  }

  async ping(timeoutMs: number): Promise<void> {
    const safeTimeoutMs = Math.max(100, Math.trunc(timeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `PostgreSQL readiness check timed out after ${safeTimeoutMs}ms`,
          ),
        );
      }, safeTimeoutMs);
    });

    const queryPromise = (async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(safeTimeoutMs),
        ]);
        await client.query('SELECT 1');
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })();

    try {
      await Promise.race([queryPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
