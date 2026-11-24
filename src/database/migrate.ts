import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const MIGRATION_ADVISORY_LOCK_ID = 840103;

export async function runMigrations(
  connectionString = process.env.DATABASE_URI,
  migrationsFolder = resolve(import.meta.dirname, '../../drizzle'),
): Promise<void> {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URI environment variable is required to run migrations',
    );
  }
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [
        MIGRATION_ADVISORY_LOCK_ID,
      ]);
      const db = drizzle(client);
      await migrate(db, { migrationsFolder });
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID])
        .catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename);

if (isEntrypoint) {
  await runMigrations();
  console.log('Database migrations applied successfully.');
}
