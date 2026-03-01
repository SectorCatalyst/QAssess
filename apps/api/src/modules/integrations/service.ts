import type { PoolClient, QueryResultRow } from 'pg';

import { recordAuditLog } from '../../lib/audit.js';
import type { DatabaseClient } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { encryptWebhookSecret } from '../../lib/webhook-secrets.js';

type QueryExecutor = DatabaseClient | PoolClient;

interface ServiceDeps {
  db: DatabaseClient;
  webhookSecretEncryptionKey: string;
}

interface WebhookEndpointRow {
  id: string;
  tenantId: string;
  name: string;
  targetUrl: string;
  subscribedEvents: unknown;
  isActive: boolean;
}

interface AssessmentRow {
  id: string;
}

interface LeadExportRow {
  leadId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  company: string | null;
  consent: boolean;
  createdAt: Date | string;
  sessionId: string | null;
  sessionStatus: string | null;
  normalizedScore: string | number | null;
}

function asExecutor(executor: QueryExecutor): {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
} {
  return executor as unknown as {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function toDateOnly(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function resolveDateRange(input: { dateFrom?: string; dateTo?: string }): { dateFrom: string; dateTo: string } {
  const today = new Date();

  const dateTo = input.dateTo ? new Date(`${input.dateTo}T00:00:00.000Z`) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (Number.isNaN(dateTo.valueOf())) {
    throw new AppError(422, 'VALIDATION_ERROR', 'dateTo must be a valid ISO date');
  }

  const defaultDateFrom = new Date(dateTo);
  defaultDateFrom.setUTCDate(defaultDateFrom.getUTCDate() - 29);

  const dateFrom = input.dateFrom ? new Date(`${input.dateFrom}T00:00:00.000Z`) : defaultDateFrom;
  if (Number.isNaN(dateFrom.valueOf())) {
    throw new AppError(422, 'VALIDATION_ERROR', 'dateFrom must be a valid ISO date');
  }
  if (dateFrom > dateTo) {
    throw new AppError(422, 'VALIDATION_ERROR', 'dateFrom must be before or equal to dateTo');
  }

  return {
    dateFrom: toDateOnly(dateFrom),
    dateTo: toDateOnly(dateTo)
  };
}

function mapWebhook(row: WebhookEndpointRow): {
  id: string;
  tenantId: string;
  name: string;
  targetUrl: string;
  subscribedEvents: string[];
  isActive: boolean;
} {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    targetUrl: row.targetUrl,
    subscribedEvents: asStringArray(row.subscribedEvents),
    isActive: row.isActive
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

async function assertAssessmentInTenant(tenantId: string, assessmentId: string, executor: QueryExecutor): Promise<void> {
  const result = await asExecutor(executor).query<AssessmentRow>(
    `
      SELECT id
      FROM assessments
      WHERE id = $1
        AND tenant_id = $2
      LIMIT 1
    `,
    [assessmentId, tenantId]
  );

  if (!result.rows[0]) {
    throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'Assessment not found');
  }
}

export function createIntegrationsService(deps: ServiceDeps) {
  const { db, webhookSecretEncryptionKey } = deps;

  return {
    async listWebhookEndpoints(tenantId: string) {
      const result = await db.query<WebhookEndpointRow>(
        `
          SELECT
            id,
            tenant_id AS "tenantId",
            name,
            target_url AS "targetUrl",
            subscribed_events AS "subscribedEvents",
            is_active AS "isActive"
          FROM webhook_endpoints
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [tenantId]
      );

      return result.rows.map((row) => mapWebhook(row));
    },

    async createWebhookEndpoint(input: {
      tenantId: string;
      actorUserId: string;
      name: string;
      targetUrl: string;
      secret: string;
      subscribedEvents: string[];
    }) {
      return db.withTransaction(async (client) => {
        const encryptedSecret = encryptWebhookSecret(input.secret, webhookSecretEncryptionKey);
        const result = await asExecutor(client).query<WebhookEndpointRow>(
          `
            INSERT INTO webhook_endpoints (
              tenant_id,
              name,
              target_url,
              secret_encrypted,
              subscribed_events,
              is_active
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)
            RETURNING
              id,
              tenant_id AS "tenantId",
              name,
              target_url AS "targetUrl",
              subscribed_events AS "subscribedEvents",
              is_active AS "isActive"
          `,
          [input.tenantId, input.name, input.targetUrl, encryptedSecret, JSON.stringify(input.subscribedEvents)]
        );
        const endpoint = result.rows[0];
        if (!endpoint) {
          throw new AppError(500, 'WEBHOOK_CREATE_FAILED', 'Unable to create webhook endpoint');
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'webhook_endpoint.create',
          targetType: 'webhook_endpoint',
          targetId: endpoint.id,
          metadata: {
            subscribedEvents: input.subscribedEvents
          }
        });

        return mapWebhook(endpoint);
      });
    },

    async updateWebhookEndpoint(input: {
      tenantId: string;
      endpointId: string;
      actorUserId: string;
      patch: Partial<{
        name: string;
        targetUrl: string;
        secret: string;
        subscribedEvents: string[];
        isActive: boolean;
      }>;
    }) {
      return db.withTransaction(async (client) => {
        const hasSecretPatch = typeof input.patch.secret === 'string';
        const encryptedSecret = hasSecretPatch ? encryptWebhookSecret(input.patch.secret ?? '', webhookSecretEncryptionKey) : null;
        const result = await asExecutor(client).query<WebhookEndpointRow>(
          `
            UPDATE webhook_endpoints
            SET
              name = CASE WHEN $3 THEN $4 ELSE name END,
              target_url = CASE WHEN $5 THEN $6 ELSE target_url END,
              secret_encrypted = CASE WHEN $7 THEN $8 ELSE secret_encrypted END,
              subscribed_events = CASE WHEN $9 THEN $10::jsonb ELSE subscribed_events END,
              is_active = CASE WHEN $11 THEN $12 ELSE is_active END,
              updated_at = now()
            WHERE id = $1
              AND tenant_id = $2
            RETURNING
              id,
              tenant_id AS "tenantId",
              name,
              target_url AS "targetUrl",
              subscribed_events AS "subscribedEvents",
              is_active AS "isActive"
          `,
          [
            input.endpointId,
            input.tenantId,
            typeof input.patch.name === 'string',
            input.patch.name ?? null,
            typeof input.patch.targetUrl === 'string',
            input.patch.targetUrl ?? null,
            hasSecretPatch,
            encryptedSecret,
            input.patch.subscribedEvents !== undefined,
            JSON.stringify(input.patch.subscribedEvents ?? []),
            typeof input.patch.isActive === 'boolean',
            input.patch.isActive ?? null
          ]
        );
        const endpoint = result.rows[0];
        if (!endpoint) {
          throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook endpoint not found');
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'webhook_endpoint.update',
          targetType: 'webhook_endpoint',
          targetId: endpoint.id,
          metadata: {
            patchedFields: Object.keys(input.patch)
          }
        });

        return mapWebhook(endpoint);
      });
    },

    async deleteWebhookEndpoint(input: {
      tenantId: string;
      endpointId: string;
      actorUserId: string;
    }) {
      return db.withTransaction(async (client) => {
        const deleted = await asExecutor(client).query<{ id: string }>(
          `
            DELETE FROM webhook_endpoints
            WHERE id = $1
              AND tenant_id = $2
            RETURNING id
          `,
          [input.endpointId, input.tenantId]
        );

        if (!deleted.rows[0]) {
          throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook endpoint not found');
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'webhook_endpoint.delete',
          targetType: 'webhook_endpoint',
          targetId: input.endpointId
        });
      });
    },

    async exportLeadsCsv(input: {
      tenantId: string;
      assessmentId: string;
      dateFrom?: string;
      dateTo?: string;
    }) {
      const range = resolveDateRange(input);

      await assertAssessmentInTenant(input.tenantId, input.assessmentId, db);

      const result = await db.query<LeadExportRow>(
        `
          WITH latest_session AS (
            SELECT
              lead_id AS "leadId",
              MAX(started_at) AS "latestStartedAt"
            FROM sessions
            WHERE lead_id IS NOT NULL
            GROUP BY lead_id
          ),
          lead_with_latest_session AS (
            SELECT
              l.id AS "leadId",
              l.email,
              l.first_name AS "firstName",
              l.last_name AS "lastName",
              l.phone,
              l.company,
              l.consent,
              l.created_at AS "createdAt",
              s.id AS "sessionId",
              s.status AS "sessionStatus"
            FROM leads l
            LEFT JOIN latest_session ls ON ls."leadId" = l.id
            LEFT JOIN sessions s
              ON s.lead_id = l.id
             AND s.started_at = ls."latestStartedAt"
            WHERE l.tenant_id = $1
              AND l.assessment_id = $2
              AND l.created_at::date BETWEEN $3::date AND $4::date
          )
          SELECT
            lwls."leadId",
            lwls.email,
            lwls."firstName",
            lwls."lastName",
            lwls.phone,
            lwls.company,
            lwls.consent,
            lwls."createdAt",
            lwls."sessionId",
            lwls."sessionStatus",
            r.normalized_score AS "normalizedScore"
          FROM lead_with_latest_session lwls
          LEFT JOIN results r ON r.session_id = lwls."sessionId"
          ORDER BY lwls."createdAt" DESC
        `,
        [input.tenantId, input.assessmentId, range.dateFrom, range.dateTo]
      );

      const header = [
        'leadId',
        'email',
        'firstName',
        'lastName',
        'phone',
        'company',
        'consent',
        'createdAt',
        'latestSessionId',
        'latestSessionStatus',
        'normalizedScore'
      ];
      const lines = [header.join(',')];

      for (const row of result.rows) {
        lines.push(
          [
            csvEscape(row.leadId),
            csvEscape(row.email),
            csvEscape(row.firstName),
            csvEscape(row.lastName),
            csvEscape(row.phone),
            csvEscape(row.company),
            csvEscape(row.consent),
            csvEscape(toIso(row.createdAt)),
            csvEscape(row.sessionId),
            csvEscape(row.sessionStatus),
            csvEscape(row.normalizedScore)
          ].join(',')
        );
      }

      return lines.join('\n');
    }
  };
}

export type IntegrationsService = ReturnType<typeof createIntegrationsService>;
