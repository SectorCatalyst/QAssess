import type { PoolClient } from 'pg';

import type { DatabaseClient } from './db.js';

type AuditQueryExecutor = DatabaseClient | PoolClient;

export interface AuditLogEntry {
  tenantId: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAuditLog(executor: AuditQueryExecutor, entry: AuditLogEntry): Promise<void> {
  await (executor as {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  }).query(
    `
      INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      entry.tenantId,
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {})
    ]
  );
}
