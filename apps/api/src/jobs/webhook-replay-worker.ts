import { pathToFileURL } from 'node:url';

import { createDatabaseClient, type DatabaseClient } from '../lib/db.js';
import { logger } from '../lib/logger.js';

interface ReplayCandidateRow {
  deliveryId: string;
}

interface ReplayUpdatedRow {
  deliveryId: string;
}

export interface WebhookReplayWorkerRunResult {
  selected: number;
  replayed: number;
  dryRun: boolean;
}

interface WebhookReplayWorkerOptions {
  db?: DatabaseClient;
  limit?: number;
  endpointId?: string;
  eventType?: string;
  resetAttempts?: boolean;
  dryRun?: boolean;
}

interface ParsedCliArgs {
  limit?: number;
  endpointId?: string;
  eventType?: string;
  resetAttempts?: boolean;
  dryRun?: boolean;
  help?: boolean;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(raw: string, argName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${argName} must be a positive integer`);
  }
  return value;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--reset-attempts') {
      parsed.resetAttempts = true;
      continue;
    }
    if (arg === '--no-reset-attempts') {
      parsed.resetAttempts = false;
      continue;
    }

    if (arg === '--limit') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--limit requires a value');
      }
      parsed.limit = parsePositiveInt(next, '--limit');
      index += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      parsed.limit = parsePositiveInt(arg.slice('--limit='.length), '--limit');
      continue;
    }

    if (arg === '--endpoint-id') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--endpoint-id requires a value');
      }
      parsed.endpointId = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--endpoint-id=')) {
      parsed.endpointId = arg.slice('--endpoint-id='.length);
      continue;
    }

    if (arg === '--event-type') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--event-type requires a value');
      }
      parsed.eventType = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--event-type=')) {
      parsed.eventType = arg.slice('--event-type='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  npm run worker:webhook:replay -- [--limit 100] [--endpoint-id <id>] [--event-type <type>] [--dry-run] [--no-reset-attempts]',
      '',
      'Options:',
      '  --limit <n>            Maximum dead-letter deliveries to replay (default: 100)',
      '  --endpoint-id <id>     Replay only deliveries for a specific webhook endpoint',
      '  --event-type <type>    Replay only deliveries for a specific event type',
      '  --dry-run              Show how many deliveries would be replayed without updating rows',
      '  --no-reset-attempts    Preserve attempt_count instead of resetting to 0',
      '  --reset-attempts       Explicitly reset attempt_count to 0 (default behavior)',
      '  --help, -h             Show this help output'
    ].join('\n') + '\n'
  );
}

async function listReplayCandidates(
  db: DatabaseClient,
  options: {
    limit: number;
    endpointId?: string;
    eventType?: string;
  }
): Promise<ReplayCandidateRow[]> {
  const result = await db.query<ReplayCandidateRow>(
    `
      SELECT
        d.id AS "deliveryId"
      FROM webhook_deliveries d
      JOIN webhook_events e ON e.id = d.webhook_event_id
      WHERE d.status = 'dead_letter'
        AND ($1::text IS NULL OR d.webhook_endpoint_id::text = $1)
        AND ($2::text IS NULL OR e.event_type = $2)
      ORDER BY d.created_at ASC
      LIMIT $3
    `,
    [options.endpointId ?? null, options.eventType ?? null, options.limit]
  );

  return result.rows;
}

async function replayDelivery(
  db: DatabaseClient,
  input: {
    deliveryId: string;
    resetAttempts: boolean;
  }
): Promise<boolean> {
  const result = await db.query<ReplayUpdatedRow>(
    `
      UPDATE webhook_deliveries
      SET
        status = 'failed',
        attempt_count = CASE WHEN $2 THEN 0 ELSE attempt_count END,
        next_retry_at = now(),
        last_error = NULL,
        updated_at = now()
      WHERE id = $1
        AND status = 'dead_letter'
      RETURNING id AS "deliveryId"
    `,
    [input.deliveryId, input.resetAttempts]
  );

  return Boolean(result.rows[0]);
}

export async function runWebhookReplayWorker(
  options: WebhookReplayWorkerOptions = {}
): Promise<WebhookReplayWorkerRunResult> {
  const configuredLimit = options.limit;
  const limit = typeof configuredLimit === 'number' && Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 100;
  const resetAttempts = options.resetAttempts ?? true;
  const dryRun = options.dryRun ?? false;

  const db = options.db ?? createDatabaseClient(requiredEnv('DATABASE_URL'));
  const shouldClose = options.db === undefined;

  try {
    const replayFilter: {
      limit: number;
      endpointId?: string;
      eventType?: string;
    } = { limit };
    if (typeof options.endpointId === 'string' && options.endpointId.length > 0) {
      replayFilter.endpointId = options.endpointId;
    }
    if (typeof options.eventType === 'string' && options.eventType.length > 0) {
      replayFilter.eventType = options.eventType;
    }

    const candidates = await listReplayCandidates(db, replayFilter);

    if (dryRun) {
      return {
        selected: candidates.length,
        replayed: 0,
        dryRun: true
      };
    }

    let replayed = 0;
    for (const candidate of candidates) {
      const updated = await replayDelivery(db, {
        deliveryId: candidate.deliveryId,
        resetAttempts
      });
      if (updated) {
        replayed += 1;
      }
    }

    return {
      selected: candidates.length,
      replayed,
      dryRun: false
    };
  } finally {
    if (shouldClose) {
      await db.close();
    }
  }
}

async function runFromCli(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const envLimitRaw = process.env.WEBHOOK_REPLAY_LIMIT;
  const envLimit = envLimitRaw ? parsePositiveInt(envLimitRaw, 'WEBHOOK_REPLAY_LIMIT') : undefined;
  const limit = args.limit ?? envLimit;

  const options: WebhookReplayWorkerOptions = {};
  if (typeof limit === 'number') {
    options.limit = limit;
  }
  if (typeof args.endpointId === 'string' && args.endpointId.length > 0) {
    options.endpointId = args.endpointId;
  }
  if (typeof args.eventType === 'string' && args.eventType.length > 0) {
    options.eventType = args.eventType;
  }
  if (typeof args.resetAttempts === 'boolean') {
    options.resetAttempts = args.resetAttempts;
  }
  if (typeof args.dryRun === 'boolean') {
    options.dryRun = args.dryRun;
  }

  const result = await runWebhookReplayWorker(options);

  logger.info('Webhook dead-letter replay run complete', {
    selected: result.selected,
    replayed: result.replayed,
    dryRun: result.dryRun
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromCli().catch((error) => {
    logger.error('Webhook dead-letter replay worker fatal error', { error: String(error) });
    process.exitCode = 1;
  });
}
