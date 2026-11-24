import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';

const MIGRATION_ADVISORY_LOCK_ID = 840103;
const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

async function ensureLeastPrivilegeAppRole(
  client: PoolClient,
  appUser: string,
  appPassword: string,
): Promise<void> {
  if (!PG_IDENTIFIER_RE.test(appUser)) {
    throw new Error(`Invalid POSTGRES_APP_USER identifier: ${appUser}`);
  }

  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ current_user: string }>(
      'SELECT current_user',
    );
    if (rows[0]?.current_user === appUser) {
      await client.query('COMMIT');
      return;
    }

    await client.query(
      "SELECT set_config('t103.app_role', $1, true), set_config('t103.app_pass', $2, true)",
      [appUser, appPassword],
    );

    await client.query(`
      DO $$
      DECLARE
        v_role text := current_setting('t103.app_role', true);
        v_pass text := current_setting('t103.app_pass', true);
        v_db text := current_database();
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
          EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role, v_pass);
        ELSE
          EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role, v_pass);
        END IF;
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_db, v_role);
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
        EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', v_role);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_role);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_role);
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.ledger_transactions, public.ledger_items FROM %I', v_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', v_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', v_role);
      END
      $$;
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export async function runMigrations(
  connectionString = process.env.MIGRATION_DATABASE_URI ||
    process.env.DATABASE_URI,
  migrationsFolder = resolve(import.meta.dirname, '../../drizzle'),
): Promise<void> {
  if (!connectionString) {
    throw new Error(
      'MIGRATION_DATABASE_URI or DATABASE_URI environment variable is required to run migrations',
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

      const appUser = process.env.POSTGRES_APP_USER?.trim();
      const appPassword = process.env.POSTGRES_APP_PASSWORD;
      if (appUser && appPassword) {
        await ensureLeastPrivilegeAppRole(client, appUser, appPassword);
      }
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
