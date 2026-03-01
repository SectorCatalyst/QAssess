import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createDatabaseClient, type DatabaseClient } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decryptWebhookSecret } from '../lib/webhook-secrets.js';

interface DeliveryCandidateRow {
  deliveryId: string;
  eventId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  targetUrl: string;
  secret: string;
  isActive: boolean;
}

interface ClaimedDeliveryRow {
  attemptCount: number;
}

export interface WebhookWorkerRunResult {
  processed: number;
  sent: number;
  failed: number;
  deadLetter: number;
}

interface WebhookWorkerOptions {
  db?: DatabaseClient;
  batchSize?: number;
  maxAttempts?: number;
  secretDecryptionKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveSecretDecryptionKey(): string {
  const fromDedicatedKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (typeof fromDedicatedKey === 'string' && fromDedicatedKey.trim().length > 0) {
    return fromDedicatedKey;
  }

  const legacyFallback = process.env.JWT_REFRESH_SECRET;
  if (typeof legacyFallback === 'string' && legacyFallback.trim().length > 0) {
    return legacyFallback;
  }

  throw new Error('No webhook secret decryption key configured (WEBHOOK_SECRET_ENCRYPTION_KEY)');
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function computeBackoffSeconds(attemptCount: number): number {
  const base = 30;
  const backoff = base * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(backoff, 3600);
}

function buildSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function listDueDeliveries(db: DatabaseClient, batchSize: number): Promise<DeliveryCandidateRow[]> {
  const result = await db.query<DeliveryCandidateRow>(
    `
      SELECT
        d.id AS "deliveryId",
        d.webhook_event_id AS "eventId",
        d.webhook_endpoint_id AS "endpointId",
        e.event_type AS "eventType",
        e.payload AS payload,
        w.target_url AS "targetUrl",
        w.secret_encrypted AS secret,
        w.is_active AS "isActive"
      FROM webhook_deliveries d
      JOIN webhook_events e ON e.id = d.webhook_event_id
      JOIN webhook_endpoints w ON w.id = d.webhook_endpoint_id
      WHERE d.status IN ('pending', 'failed')
        AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
      ORDER BY d.created_at ASC
      LIMIT $1
    `,
    [batchSize]
  );

  return result.rows;
}

async function claimDelivery(db: DatabaseClient, deliveryId: string): Promise<ClaimedDeliveryRow | null> {
  const result = await db.query<ClaimedDeliveryRow>(
    `
      UPDATE webhook_deliveries
      SET
        status = 'failed',
        attempt_count = attempt_count + 1,
        updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      RETURNING
        attempt_count AS "attemptCount"
    `,
    [deliveryId]
  );

  return result.rows[0] ?? null;
}

async function markSent(db: DatabaseClient, deliveryId: string, httpStatus: number): Promise<void> {
  await db.query(
    `
      UPDATE webhook_deliveries
      SET
        status = 'sent',
        last_http_status = $2,
        last_error = NULL,
        delivered_at = now(),
        next_retry_at = NULL,
        updated_at = now()
      WHERE id = $1
    `,
    [deliveryId, httpStatus]
  );
}

async function markFailed(
  db: DatabaseClient,
  deliveryId: string,
  attemptCount: number,
  maxAttempts: number,
  now: Date,
  input: {
    httpStatus?: number;
    errorMessage: string;
  }
): Promise<'failed' | 'dead_letter'> {
  if (attemptCount >= maxAttempts) {
    await db.query(
      `
        UPDATE webhook_deliveries
        SET
          status = 'dead_letter',
          next_retry_at = NULL,
          last_http_status = $2,
          last_error = $3,
          updated_at = now()
        WHERE id = $1
      `,
      [deliveryId, input.httpStatus ?? null, input.errorMessage]
    );
    return 'dead_letter';
  }

  const nextRetryAt = new Date(now);
  nextRetryAt.setSeconds(nextRetryAt.getSeconds() + computeBackoffSeconds(attemptCount));

  await db.query(
    `
      UPDATE webhook_deliveries
      SET
        status = 'failed',
        next_retry_at = $2,
        last_http_status = $3,
        last_error = $4,
        updated_at = now()
      WHERE id = $1
    `,
    [deliveryId, nextRetryAt.toISOString(), input.httpStatus ?? null, input.errorMessage]
  );

  return 'failed';
}

export async function runWebhookWorker(options: WebhookWorkerOptions = {}): Promise<WebhookWorkerRunResult> {
  const batchSize = Math.max(1, options.batchSize ?? 50);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const secretDecryptionKey = options.secretDecryptionKey ?? resolveSecretDecryptionKey();

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available for webhook worker');
  }

  const nowFactory = options.now ?? (() => new Date());
  const db = options.db ?? createDatabaseClient(requiredEnv('DATABASE_URL'));
  const shouldClose = options.db === undefined;

  try {
    const due = await listDueDeliveries(db, batchSize);
    const result: WebhookWorkerRunResult = {
      processed: 0,
      sent: 0,
      failed: 0,
      deadLetter: 0
    };

    for (const candidate of due) {
      const claim = await claimDelivery(db, candidate.deliveryId);
      if (!claim) {
        continue;
      }

      result.processed += 1;

      if (!candidate.isActive) {
        const status = await markFailed(db, candidate.deliveryId, claim.attemptCount, maxAttempts, nowFactory(), {
          errorMessage: 'Endpoint inactive'
        });
        if (status === 'dead_letter') {
          result.deadLetter += 1;
        } else {
          result.failed += 1;
        }
        continue;
      }

      try {
        const decryptedSecret = decryptWebhookSecret(candidate.secret, secretDecryptionKey);
        const timestamp = nowFactory().toISOString();
        const payload = {
          id: candidate.eventId,
          type: candidate.eventType,
          occurredAt: timestamp,
          payload: asObject(candidate.payload)
        };
        const body = JSON.stringify(payload);
        const signature = buildSignature(decryptedSecret, timestamp, body);

        const response = await fetchImpl(candidate.targetUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qassess-event': candidate.eventType,
            'x-qassess-signature': signature,
            'x-qassess-timestamp': timestamp
          },
          body
        });

        if (response.ok) {
          await markSent(db, candidate.deliveryId, response.status);
          result.sent += 1;
        } else {
          const status = await markFailed(db, candidate.deliveryId, claim.attemptCount, maxAttempts, nowFactory(), {
            httpStatus: response.status,
            errorMessage: `HTTP ${response.status}`
          });
          if (status === 'dead_letter') {
            result.deadLetter += 1;
          } else {
            result.failed += 1;
          }
        }
      } catch (error) {
        const status = await markFailed(db, candidate.deliveryId, claim.attemptCount, maxAttempts, nowFactory(), {
          errorMessage: String(error).slice(0, 1000)
        });
        if (status === 'dead_letter') {
          result.deadLetter += 1;
        } else {
          result.failed += 1;
        }
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
  const batchSizeRaw = process.env.WEBHOOK_WORKER_BATCH_SIZE;
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : undefined;
  const maxAttemptsRaw = process.env.WEBHOOK_WORKER_MAX_ATTEMPTS;
  const maxAttempts = maxAttemptsRaw ? Number(maxAttemptsRaw) : undefined;

  const options: WebhookWorkerOptions = {};
  if (typeof batchSize === 'number' && Number.isFinite(batchSize)) {
    options.batchSize = batchSize;
  }
  if (typeof maxAttempts === 'number' && Number.isFinite(maxAttempts) && maxAttempts >= 1) {
    options.maxAttempts = Math.trunc(maxAttempts);
  }

  const result = await runWebhookWorker(options);

  logger.info('Webhook worker run complete', {
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
    deadLetter: result.deadLetter
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromCli().catch((error) => {
    logger.error('Webhook worker fatal error', { error: String(error) });
    process.exitCode = 1;
  });
}
