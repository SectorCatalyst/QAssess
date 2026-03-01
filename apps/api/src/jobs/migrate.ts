import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';

interface MigrationFile {
  version: string;
  fullPath: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function listMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({
      version: entry.name,
      fullPath: path.join(migrationsDir, entry.name)
    }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function run(): Promise<void> {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const migrationsDir = path.resolve(process.cwd(), 'db/migrations');

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await ensureMigrationsTable(pool);

    const files = await listMigrationFiles(migrationsDir);
    if (files.length === 0) {
      process.stdout.write('No migration files found.\n');
      return;
    }

    for (const file of files) {
      const sql = await readFile(file.fullPath, 'utf8');
      const checksum = sha256(sql);

      const existing = await pool.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations WHERE version = $1 LIMIT 1',
        [file.version]
      );

      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.checksum !== checksum) {
          throw new Error(`Checksum mismatch for migration ${file.version}. Expected ${prior.checksum}, got ${checksum}.`);
        }

        process.stdout.write(`Skipping ${file.version} (already applied).\n`);
        continue;
      }

      process.stdout.write(`Applying ${file.version}...\n`);
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file.version, checksum]);
      process.stdout.write(`Applied ${file.version}.\n`);
    }

    process.stdout.write('Migrations complete.\n');
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});
