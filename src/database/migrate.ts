import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export async function runMigrations(
  connectionString = process.env.DATABASE_URL ??
    'postgres://t103:t103_secret@localhost:5432/t103_wallet',
  migrationsFolder = resolve(import.meta.dirname, '../../drizzle'),
): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
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
