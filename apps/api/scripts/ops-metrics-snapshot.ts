import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';

interface SnapshotOptions {
  databaseUrl: string;
  assertThresholds: boolean;
  reportPath: string | undefined;
  maxPdfQueued: number | undefined;
  maxPdfProcessing: number | undefined;
  maxPdfFailed: number | undefined;
  maxWebhookPending: number | undefined;
  maxWebhookFailed: number | undefined;
  maxWebhookDeadLetter: number | undefined;
  maxWebhookDeadLetter15m: number | undefined;
}

interface StatusCount {
  status: string;
  count: string | number;
}

interface SingleCount {
  count: string | number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  throw new Error('Boolean env value must be true/false, yes/no, 1/0, or on/off');
}

function parseNonNegativeInt(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function readThreshold(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return parseNonNegativeInt(raw, name);
}

function parseCliArgs(argv: string[]): { reportPath?: string; assertThresholds?: boolean; help?: boolean } {
  const parsed: { reportPath?: string; assertThresholds?: boolean; help?: boolean } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--assert-thresholds') {
      parsed.assertThresholds = true;
      continue;
    }
    if (arg === '--no-assert-thresholds') {
      parsed.assertThresholds = false;
      continue;
    }

    if (arg === '--report-path') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--report-path requires a value');
      }
      parsed.reportPath = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--report-path=')) {
      parsed.reportPath = arg.slice('--report-path='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      'QAssess ops metrics snapshot',
      '',
      'Usage:',
      '  npm run ops:metrics:snapshot -- [--assert-thresholds] [--report-path <path>]',
      '',
      'Required env:',
      '  DATABASE_URL',
      '',
      'Optional env thresholds (non-negative integers):',
      '  OPS_MAX_PDF_QUEUED',
      '  OPS_MAX_PDF_PROCESSING',
      '  OPS_MAX_PDF_FAILED',
      '  OPS_MAX_WEBHOOK_PENDING',
      '  OPS_MAX_WEBHOOK_FAILED',
      '  OPS_MAX_WEBHOOK_DEAD_LETTER',
      '  OPS_MAX_WEBHOOK_DEAD_LETTER_15M',
      '',
      'Optional env:',
      '  OPS_ASSERT_THRESHOLDS=true|false',
      '  OPS_METRICS_REPORT_PATH=<path>',
      '',
      'Exit codes:',
      '  0 => snapshot collected (and thresholds passed if asserted)',
      '  1 => threshold assertion failed or runtime error'
    ].join('\n') + '\n'
  );
}

function toCount(value: string | number | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function statusMap(rows: StatusCount[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.status] = toCount(row.count);
  }
  return out;
}

function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function collectSnapshot(options: SnapshotOptions): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: options.databaseUrl });

  try {
    await pool.query('SELECT 1');

    const pdfRows = await pool.query<StatusCount>(
      `
        SELECT status::text AS status, COUNT(*)::bigint AS count
        FROM pdf_jobs
        GROUP BY status
      `
    );
    const webhookRows = await pool.query<StatusCount>(
      `
        SELECT status::text AS status, COUNT(*)::bigint AS count
        FROM webhook_deliveries
        GROUP BY status
      `
    );
    const webhookDeadLetter15m = await pool.query<SingleCount>(
      `
        SELECT COUNT(*)::bigint AS count
        FROM webhook_deliveries
        WHERE status = 'dead_letter'
          AND updated_at >= now() - interval '15 minutes'
      `
    );

    const pdf = statusMap(pdfRows.rows);
    const webhook = statusMap(webhookRows.rows);

    const snapshot: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      dbReady: true,
      pdfJobs: {
        queued: pdf.queued ?? 0,
        processing: pdf.processing ?? 0,
        completed: pdf.completed ?? 0,
        failed: pdf.failed ?? 0,
        total: Object.values(pdf).reduce((sum, count) => sum + count, 0)
      },
      webhookDeliveries: {
        pending: webhook.pending ?? 0,
        failed: webhook.failed ?? 0,
        sent: webhook.sent ?? 0,
        deadLetter: webhook.dead_letter ?? 0,
        deadLetter15m: toCount(webhookDeadLetter15m.rows[0]?.count),
        total: Object.values(webhook).reduce((sum, count) => sum + count, 0)
      }
    };

    return snapshot;
  } finally {
    await pool.end();
  }
}

function evaluateThresholds(
  snapshot: Record<string, unknown>,
  options: SnapshotOptions
): Array<{ metric: string; value: number; max: number }> {
  const violations: Array<{ metric: string; value: number; max: number }> = [];
  const pdf = (snapshot.pdfJobs ?? {}) as Record<string, unknown>;
  const webhook = (snapshot.webhookDeliveries ?? {}) as Record<string, unknown>;

  const checks: Array<{ metric: string; value: number; max: number | undefined }> = [
    { metric: 'pdf.queued', value: toCount(pdf.queued as string | number | undefined), max: options.maxPdfQueued },
    { metric: 'pdf.processing', value: toCount(pdf.processing as string | number | undefined), max: options.maxPdfProcessing },
    { metric: 'pdf.failed', value: toCount(pdf.failed as string | number | undefined), max: options.maxPdfFailed },
    { metric: 'webhook.pending', value: toCount(webhook.pending as string | number | undefined), max: options.maxWebhookPending },
    { metric: 'webhook.failed', value: toCount(webhook.failed as string | number | undefined), max: options.maxWebhookFailed },
    { metric: 'webhook.dead_letter', value: toCount(webhook.deadLetter as string | number | undefined), max: options.maxWebhookDeadLetter },
    {
      metric: 'webhook.dead_letter_15m',
      value: toCount(webhook.deadLetter15m as string | number | undefined),
      max: options.maxWebhookDeadLetter15m
    }
  ];

  for (const check of checks) {
    if (check.max === undefined) {
      continue;
    }
    if (check.value > check.max) {
      violations.push({ metric: check.metric, value: check.value, max: check.max });
    }
  }

  return violations;
}

async function maybeWriteReport(reportPath: string | undefined, snapshot: Record<string, unknown>): Promise<void> {
  if (!reportPath) {
    return;
  }

  const targetPath = path.isAbsolute(reportPath)
    ? reportPath
    : path.resolve(process.cwd(), reportPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }

  const reportPath =
    args.reportPath ??
    process.env.OPS_METRICS_REPORT_PATH ??
    path.resolve(process.cwd(), 'artifacts', `ops-metrics-${formatTimestamp(new Date())}.json`);

  const options: SnapshotOptions = {
    databaseUrl,
    assertThresholds: args.assertThresholds ?? parseBool(process.env.OPS_ASSERT_THRESHOLDS, false),
    reportPath,
    maxPdfQueued: readThreshold('OPS_MAX_PDF_QUEUED'),
    maxPdfProcessing: readThreshold('OPS_MAX_PDF_PROCESSING'),
    maxPdfFailed: readThreshold('OPS_MAX_PDF_FAILED'),
    maxWebhookPending: readThreshold('OPS_MAX_WEBHOOK_PENDING'),
    maxWebhookFailed: readThreshold('OPS_MAX_WEBHOOK_FAILED'),
    maxWebhookDeadLetter: readThreshold('OPS_MAX_WEBHOOK_DEAD_LETTER'),
    maxWebhookDeadLetter15m: readThreshold('OPS_MAX_WEBHOOK_DEAD_LETTER_15M')
  };

  const snapshot = await collectSnapshot(options);
  await maybeWriteReport(options.reportPath, snapshot);

  const violations = evaluateThresholds(snapshot, options);

  const output: Record<string, unknown> = {
    ...snapshot,
    assertThresholds: options.assertThresholds,
    thresholds: {
      maxPdfQueued: options.maxPdfQueued,
      maxPdfProcessing: options.maxPdfProcessing,
      maxPdfFailed: options.maxPdfFailed,
      maxWebhookPending: options.maxWebhookPending,
      maxWebhookFailed: options.maxWebhookFailed,
      maxWebhookDeadLetter: options.maxWebhookDeadLetter,
      maxWebhookDeadLetter15m: options.maxWebhookDeadLetter15m
    },
    thresholdViolations: violations,
    reportPath: options.reportPath
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (options.assertThresholds && violations.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`ops-metrics-snapshot failed: ${String(error)}\n`);
  process.exitCode = 1;
});
