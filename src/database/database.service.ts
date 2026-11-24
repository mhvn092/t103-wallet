import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { EnvConfig } from '../config/env.validation.js';
import type { AppDatabase, DbTransaction } from './database.types.js';
import * as schema from './schema/index.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: AppDatabase;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.pool = new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: 25,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async runInTransaction<T>(
    fn: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(fn, { isolationLevel: 'read committed' });
  }

  async ping(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
