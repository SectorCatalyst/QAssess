import type { PoolClient, QueryResultRow } from 'pg';

import type { DatabaseClient } from './db.js';

type QueryExecutor = DatabaseClient | PoolClient;

type WebhookEventType = 'lead.created' | 'session.completed' | 'pdf.generated';

interface WebhookEndpointRow {
  id: string;
  subscribedEvents: unknown;
}

interface WebhookEventRow {
  id: string;
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

export async function enqueueWebhookEvent(
  executor: QueryExecutor,
  input: {
    tenantId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
    dedupeKey?: string;
  }
): Promise<{
  eventId: string;
  deliveryCount: number;
}> {
  let eventId: string | undefined;

  if (typeof input.dedupeKey === 'string' && input.dedupeKey.length > 0) {
    const existing = await asExecutor(executor).query<WebhookEventRow>(
      `
        SELECT id
        FROM webhook_events
        WHERE tenant_id = $1
          AND event_type = $2
          AND dedupe_key = $3
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.tenantId, input.eventType, input.dedupeKey]
    );

    eventId = existing.rows[0]?.id;
  }

  if (!eventId) {
    const inserted = await asExecutor(executor).query<WebhookEventRow>(
      `
        INSERT INTO webhook_events (
          tenant_id,
          event_type,
          dedupe_key,
          payload
        )
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING id
      `,
      [input.tenantId, input.eventType, input.dedupeKey ?? null, JSON.stringify(input.payload)]
    );
    eventId = inserted.rows[0]?.id;
  }

  if (!eventId) {
    throw new Error('Failed to enqueue webhook event');
  }

  const endpoints = await asExecutor(executor).query<WebhookEndpointRow>(
    `
      SELECT
        id,
        subscribed_events AS "subscribedEvents"
      FROM webhook_endpoints
      WHERE tenant_id = $1
        AND is_active = TRUE
    `,
    [input.tenantId]
  );

  let deliveryCount = 0;
  for (const endpoint of endpoints.rows) {
    const subscribed = new Set(asStringArray(endpoint.subscribedEvents));
    if (!subscribed.has(input.eventType)) {
      continue;
    }

    await asExecutor(executor).query(
      `
        INSERT INTO webhook_deliveries (
          webhook_event_id,
          webhook_endpoint_id,
          status,
          attempt_count,
          next_retry_at
        )
        VALUES ($1, $2, 'pending', 0, now())
        ON CONFLICT (webhook_event_id, webhook_endpoint_id) DO NOTHING
      `,
      [eventId, endpoint.id]
    );
    deliveryCount += 1;
  }

  return {
    eventId,
    deliveryCount
  };
}

export type { WebhookEventType };
