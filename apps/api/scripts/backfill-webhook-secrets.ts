import { createDatabaseClient } from '../src/lib/db.js';
import { encryptWebhookSecret } from '../src/lib/webhook-secrets.js';

interface ParsedArgs {
  dryRun: boolean;
  limit: number;
}

interface LegacyWebhookRow {
  id: string;
  secret: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveEncryptionKey(): string {
  const dedicated = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (typeof dedicated === 'string' && dedicated.trim().length > 0) {
    return dedicated;
  }

  const fallback = process.env.JWT_REFRESH_SECRET;
  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback;
  }

  throw new Error('Missing required environment variable: WEBHOOK_SECRET_ENCRYPTION_KEY');
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let limit = 500;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--limit') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--limit requires a value');
      }
      limit = parsePositiveInt(next, '--limit');
      index += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = parsePositiveInt(arg.slice('--limit='.length), '--limit');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    limit
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  npm run ops:webhook-secrets:backfill -- [--limit 500] [--dry-run]',
      '',
      'Behavior:',
      '  - Finds webhook_endpoints rows whose secret_encrypted is still plaintext.',
      '  - Encrypts those secrets in place using WEBHOOK_SECRET_ENCRYPTION_KEY.',
      '  - Leaves already-encrypted rows unchanged.',
      '',
      'Required env:',
      '  - DATABASE_URL',
      '  - WEBHOOK_SECRET_ENCRYPTION_KEY (or fallback JWT_REFRESH_SECRET)'
    ].join('\n') + '\n'
  );
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = requiredEnv('DATABASE_URL');
  const encryptionKey = resolveEncryptionKey();
  const db = createDatabaseClient(databaseUrl);

  try {
    const legacy = await db.query<LegacyWebhookRow>(
      `
        SELECT
          id,
          secret_encrypted AS secret
        FROM webhook_endpoints
        WHERE secret_encrypted NOT LIKE 'enc:v1:%'
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [args.limit]
    );

    if (args.dryRun) {
      process.stdout.write(
        `Dry run: ${legacy.rows.length} webhook endpoint secret(s) need encryption (limit=${args.limit}).\n`
      );
      return;
    }

    let updated = 0;
    for (const row of legacy.rows) {
      const encrypted = encryptWebhookSecret(row.secret, encryptionKey);
      await db.query(
        `
          UPDATE webhook_endpoints
          SET secret_encrypted = $2,
              updated_at = now()
          WHERE id = $1
        `,
        [row.id, encrypted]
      );
      updated += 1;
    }

    process.stdout.write(`Encrypted ${updated} webhook endpoint secret(s).\n`);
  } finally {
    await db.close();
  }
}

run().catch((error) => {
  process.stderr.write(`Webhook secret backfill failed: ${String(error)}\n`);
  process.exitCode = 1;
});
