import { pathToFileURL } from 'node:url';

import { createDatabaseClient, type DatabaseClient } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { enqueueWebhookEvent } from '../lib/webhooks.js';

interface QueuedPdfJobRow {
  id: string;
  sessionId: string;
}

interface ClaimedPdfJobRow {
  id: string;
  sessionId: string;
  attemptCount: number;
}

interface SessionContextRow {
  tenantId: string;
  assessmentId: string;
  status: 'in_progress' | 'completed' | 'abandoned';
}

interface ResultRow {
  normalizedScore: string | number;
}

export interface PdfWorkerRunResult {
  processed: number;
  completed: number;
  failed: number;
}

interface PdfWorkerOptions {
  db?: DatabaseClient;
  batchSize?: number;
  publicBaseUrl?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

async function claimQueuedJobs(db: DatabaseClient, batchSize: number): Promise<QueuedPdfJobRow[]> {
  const queued = await db.query<QueuedPdfJobRow>(
    `
      SELECT
        id,
        session_id AS "sessionId"
      FROM pdf_jobs
      WHERE status = 'queued'
      ORDER BY queued_at ASC
      LIMIT $1
    `,
    [batchSize]
  );

  return queued.rows;
}

async function claimOneJob(db: DatabaseClient, jobId: string): Promise<ClaimedPdfJobRow | null> {
  const claimed = await db.query<ClaimedPdfJobRow>(
    `
      UPDATE pdf_jobs
      SET
        status = 'processing',
        started_at = COALESCE(started_at, now()),
        attempt_count = attempt_count + 1,
        error_message = NULL,
        updated_at = now()
      WHERE id = $1
        AND status = 'queued'
      RETURNING
        id,
        session_id AS "sessionId",
        attempt_count AS "attemptCount"
    `,
    [jobId]
  );

  return claimed.rows[0] ?? null;
}

function buildStorageKey(claimed: ClaimedPdfJobRow, assessmentId: string): string {
  return `reports/${assessmentId}/${claimed.sessionId}/${claimed.id}.pdf`;
}

function buildFileUrl(base: string, storageKey: string): string {
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${normalized}/${storageKey}`;
}

async function processClaimedJob(
  db: DatabaseClient,
  claimed: ClaimedPdfJobRow,
  publicBaseUrl: string
): Promise<'completed' | 'failed'> {
  try {
    await db.withTransaction(async (client) => {
      const sessionResult = await client.query<SessionContextRow>(
        `
          SELECT
            a.tenant_id AS "tenantId",
            s.assessment_id AS "assessmentId",
            s.status::text AS status
          FROM sessions s
          JOIN assessments a ON a.id = s.assessment_id
          WHERE s.id = $1
          LIMIT 1
        `,
        [claimed.sessionId]
      );
      const session = sessionResult.rows[0];
      if (!session) {
        throw new Error('Session not found for PDF job');
      }
      if (session.status !== 'completed') {
        throw new Error('Session must be completed before PDF generation');
      }

      const resultLookup = await client.query<ResultRow>(
        `
          SELECT normalized_score AS "normalizedScore"
          FROM results
          WHERE session_id = $1
          LIMIT 1
        `,
        [claimed.sessionId]
      );
      if (!resultLookup.rows[0]) {
        throw new Error('Result payload not found for PDF generation');
      }

      const storageKey = buildStorageKey(claimed, session.assessmentId);
      const fileUrl = buildFileUrl(publicBaseUrl, storageKey);
      const normalizedScore = toNumber(resultLookup.rows[0].normalizedScore);

      await client.query(
        `
          UPDATE pdf_jobs
          SET
            status = 'completed',
            storage_key = $2,
            file_url = $3,
            error_message = NULL,
            completed_at = now(),
            updated_at = now()
          WHERE id = $1
        `,
        [claimed.id, storageKey, fileUrl]
      );

      await enqueueWebhookEvent(client, {
        tenantId: session.tenantId,
        eventType: 'pdf.generated',
        dedupeKey: `pdf.generated:${claimed.id}`,
        payload: {
          jobId: claimed.id,
          sessionId: claimed.sessionId,
          assessmentId: session.assessmentId,
          normalizedScore,
          fileUrl
        }
      });
    });

    logger.info('PDF job completed', {
      jobId: claimed.id,
      sessionId: claimed.sessionId
    });
    return 'completed';
  } catch (error) {
    const message = String(error).slice(0, 1000);
    await db.query(
      `
        UPDATE pdf_jobs
        SET
          status = 'failed',
          error_message = $2,
          completed_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [claimed.id, message]
    );

    logger.error('PDF job failed', {
      jobId: claimed.id,
      sessionId: claimed.sessionId,
      error: message
    });
    return 'failed';
  }
}

export async function runPdfWorker(options: PdfWorkerOptions = {}): Promise<PdfWorkerRunResult> {
  const batchSize = Math.max(1, options.batchSize ?? 25);
  const publicBaseUrl = options.publicBaseUrl ?? 'https://files.qassess.local';

  const db = options.db ?? createDatabaseClient(requiredEnv('DATABASE_URL'));
  const shouldClose = options.db === undefined;

  try {
    const queuedJobs = await claimQueuedJobs(db, batchSize);
    const result: PdfWorkerRunResult = {
      processed: 0,
      completed: 0,
      failed: 0
    };

    for (const queued of queuedJobs) {
      const claimed = await claimOneJob(db, queued.id);
      if (!claimed) {
        continue;
      }

      result.processed += 1;
      const outcome = await processClaimedJob(db, claimed, publicBaseUrl);
      if (outcome === 'completed') {
        result.completed += 1;
      } else {
        result.failed += 1;
      }
    }

    return result;
  } finally {
    if (shouldClose) {
      await db.close();
    }
  }
}

async function runFromCli(): Promise<void> {
  const batchSizeRaw = process.env.PDF_WORKER_BATCH_SIZE;
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : undefined;

  const options: PdfWorkerOptions = {};
  if (typeof batchSize === 'number' && Number.isFinite(batchSize)) {
    options.batchSize = batchSize;
  }

  const result = await runPdfWorker(options);

  logger.info('PDF worker run complete', {
    processed: result.processed,
    completed: result.completed,
    failed: result.failed
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromCli().catch((error) => {
    logger.error('PDF worker fatal error', { error: String(error) });
    process.exitCode = 1;
  });
}
