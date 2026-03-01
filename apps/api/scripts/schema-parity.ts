import { Pool } from 'pg';

interface MigrationRow {
  version: string;
  checksum: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function loadMigrations(databaseUrl: string): Promise<Map<string, string>> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await pool.query<MigrationRow>(
      `
        SELECT version, checksum
        FROM schema_migrations
        ORDER BY version ASC
      `
    );

    return new Map(result.rows.map((row) => [row.version, row.checksum]));
  } finally {
    await pool.end();
  }
}

function diffMigrations(
  source: Map<string, string>,
  target: Map<string, string>
): {
  missingInTarget: string[];
  extraInTarget: string[];
  checksumMismatch: string[];
} {
  const missingInTarget: string[] = [];
  const extraInTarget: string[] = [];
  const checksumMismatch: string[] = [];

  for (const [version, checksum] of source.entries()) {
    const targetChecksum = target.get(version);
    if (!targetChecksum) {
      missingInTarget.push(version);
      continue;
    }
    if (targetChecksum !== checksum) {
      checksumMismatch.push(version);
    }
  }

  for (const version of target.keys()) {
    if (!source.has(version)) {
      extraInTarget.push(version);
    }
  }

  return {
    missingInTarget,
    extraInTarget,
    checksumMismatch
  };
}

async function run(): Promise<void> {
  const sourceUrl = process.env.SCHEMA_SOURCE_DATABASE_URL ?? requiredEnv('DATABASE_URL');
  const targetUrl = requiredEnv('SCHEMA_TARGET_DATABASE_URL');

  const [source, target] = await Promise.all([loadMigrations(sourceUrl), loadMigrations(targetUrl)]);
  const diff = diffMigrations(source, target);

  process.stdout.write(`schema_migrations source=${source.size} target=${target.size}\n`);

  if (diff.missingInTarget.length > 0) {
    process.stdout.write(`Missing in target (${diff.missingInTarget.length}): ${diff.missingInTarget.join(', ')}\n`);
  }
  if (diff.extraInTarget.length > 0) {
    process.stdout.write(`Extra in target (${diff.extraInTarget.length}): ${diff.extraInTarget.join(', ')}\n`);
  }
  if (diff.checksumMismatch.length > 0) {
    process.stdout.write(`Checksum mismatch (${diff.checksumMismatch.length}): ${diff.checksumMismatch.join(', ')}\n`);
  }

  if (
    diff.missingInTarget.length === 0 &&
    diff.extraInTarget.length === 0 &&
    diff.checksumMismatch.length === 0
  ) {
    process.stdout.write('Schema migration parity: PASS\n');
    return;
  }

  process.stdout.write('Schema migration parity: FAIL\n');
  process.exitCode = 1;
}

run().catch((error: unknown) => {
  process.stderr.write(`Schema parity check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
