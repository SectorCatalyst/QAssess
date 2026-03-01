import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { DataType, newDb } from 'pg-mem';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { EnvConfig } from '../../src/config/env.js';
import type { DatabaseClient } from '../../src/lib/db.js';
import { createOpenApiValidationProvider } from '../../src/lib/openapi.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';

const TEST_ENV: EnvConfig = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgres://unused-for-tests',
  jwtAccessSecret: 'integration-test-access-secret',
  jwtRefreshSecret: 'integration-test-refresh-secret',
  webhookSecretEncryptionKey: 'integration-test-webhook-secret-key',
  strictSecretValidation: false,
  accessTokenTtlMinutes: 15,
  refreshTokenTtlDays: 30,
  publicBootstrapRateLimitPerMinute: 120,
  publicSessionStartRateLimitPerMinute: 60,
  publicSessionMutationRateLimitPerMinute: 180
};

interface TestContext {
  app: FastifyInstance;
  db: DatabaseClient;
}

function createInMemoryDatabaseClient(): DatabaseClient {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'lpad',
    args: [DataType.text, DataType.integer, DataType.text],
    returns: DataType.text,
    implementation: (input: string, length: number, fill: string) => {
      const source = String(input ?? '');
      const targetLength = Number(length ?? 0);
      const filler = String(fill ?? ' ');

      if (targetLength <= 0) {
        return '';
      }

      if (source.length >= targetLength) {
        return source.slice(source.length - targetLength);
      }

      if (filler.length === 0) {
        return source;
      }

      const needed = targetLength - source.length;
      return `${filler.repeat(Math.ceil(needed / filler.length)).slice(0, needed)}${source}`;
    }
  });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool() as {
    query: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
    connect: () => Promise<
      PoolClient & {
        release: () => void;
      }
    >;
    end: () => Promise<void>;
  };

  return {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      return pool.query<T>(sql, params);
    },
    async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close(): Promise<void> {
      return pool.end();
    }
  };
}

async function seedSchema(db: DatabaseClient): Promise<void> {
  await db.query(`
    CREATE TYPE assessment_status AS ENUM ('draft', 'published', 'archived');
    CREATE TYPE question_type AS ENUM ('single_choice', 'multi_choice', 'scale', 'numeric', 'short_text');
    CREATE TYPE session_status AS ENUM ('in_progress', 'completed', 'abandoned');

    CREATE SEQUENCE report_templates_id_seq START 1;
    CREATE SEQUENCE report_sections_id_seq START 1;
    CREATE SEQUENCE webhook_endpoints_id_seq START 1;
    CREATE SEQUENCE leads_id_seq START 1;
    CREATE SEQUENCE sessions_id_seq START 1;
    CREATE SEQUENCE responses_id_seq START 1;
    CREATE SEQUENCE results_id_seq START 1;
  `);

  await db.query(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  await db.query(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, email)
    )
  `);

  await db.query(`
    CREATE TABLE refresh_tokens (
      jti TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE audit_logs (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE assessments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status assessment_status NOT NULL DEFAULT 'draft',
      description TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, slug)
    )
  `);

  await db.query(`
    CREATE TABLE assessment_versions (
      id TEXT PRIMARY KEY,
      assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      published_at TIMESTAMPTZ,
      title TEXT NOT NULL,
      intro_copy TEXT,
      outro_copy TEXT,
      lead_capture_mode TEXT NOT NULL DEFAULT 'before_results',
      lead_capture_step INTEGER,
      runtime_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (assessment_id, version_no)
    )
  `);

  await db.query(`
    CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
      type question_type NOT NULL,
      prompt TEXT NOT NULL,
      help_text TEXT,
      is_required BOOLEAN NOT NULL DEFAULT TRUE,
      position INTEGER NOT NULL,
      weight NUMERIC(8,4) NOT NULL DEFAULT 1,
      min_value NUMERIC(12,4),
      max_value NUMERIC(12,4),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE report_templates (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8500-' || lpad(nextval('report_templates_id_seq')::text, 12, '0')),
      assessment_version_id TEXT NOT NULL UNIQUE REFERENCES assessment_versions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      header_content JSONB NOT NULL DEFAULT '{}'::jsonb,
      footer_content JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE report_sections (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8510-' || lpad(nextval('report_sections_id_seq')::text, 12, '0')),
      report_template_id TEXT NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
      section_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body_template TEXT NOT NULL,
      display_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (report_template_id, position),
      UNIQUE (report_template_id, section_key)
    )
  `);

  await db.query(`
    CREATE TABLE webhook_endpoints (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8520-' || lpad(nextval('webhook_endpoints_id_seq')::text, 12, '0')),
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target_url TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      subscribed_events JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8530-' || lpad(nextval('leads_id_seq')::text, 12, '0')),
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      company TEXT,
      custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      consent_at TIMESTAMPTZ,
      source_utm JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8600-' || lpad(nextval('sessions_id_seq')::text, 12, '0')),
      assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      status session_status NOT NULL DEFAULT 'in_progress',
      current_question_position INTEGER,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      abandoned_at TIMESTAMPTZ,
      runtime_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      client_fingerprint TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE responses (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8700-' || lpad(nextval('responses_id_seq')::text, 12, '0')),
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer_json JSONB NOT NULL,
      computed_score NUMERIC(12,4) NOT NULL DEFAULT 0,
      answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (session_id, question_id)
    )
  `);

  await db.query(`
    CREATE TABLE results (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8800-' || lpad(nextval('results_id_seq')::text, 12, '0')),
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      score_band_id TEXT,
      raw_score NUMERIC(12,4) NOT NULL DEFAULT 0,
      normalized_score NUMERIC(6,2) NOT NULL,
      max_possible_raw_score NUMERIC(12,4) NOT NULL DEFAULT 0,
      breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
      generated_report JSONB NOT NULL DEFAULT '{}'::jsonb,
      finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE analytics_daily_assessment (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      date_key DATE NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      starts INTEGER NOT NULL DEFAULT 0,
      completions INTEGER NOT NULL DEFAULT 0,
      leads INTEGER NOT NULL DEFAULT 0,
      avg_score NUMERIC(6,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, assessment_id, date_key)
    )
  `);

  const passwordHash = await hashPassword('ChangeMe123!');

  await db.query(`
    INSERT INTO tenants (id, name, slug, status)
    VALUES ('tenant-acme', 'Acme Advisory', 'acme', 'active')
  `);

  await db.query(
    `
      INSERT INTO users (id, tenant_id, email, password_hash, role, status, first_name, last_name)
      VALUES ('user-acme-owner', 'tenant-acme', 'owner@acme.example', $1, 'owner', 'active', 'Acme', 'Owner')
    `,
    [passwordHash]
  );

  await db.query(`
    INSERT INTO assessments (id, tenant_id, name, slug, status, created_by)
    VALUES (
      '00000000-0000-4000-8000-000000001111',
      'tenant-acme',
      'Growth Assessment',
      'growth-assessment',
      'draft',
      'user-acme-owner'
    )
  `);

  await db.query(`
    INSERT INTO assessment_versions (
      id,
      assessment_id,
      version_no,
      is_published,
      title,
      lead_capture_mode,
      runtime_settings,
      created_by
    )
    VALUES (
      '00000000-0000-4000-8100-000000001111',
      '00000000-0000-4000-8000-000000001111',
      1,
      FALSE,
      'Growth Version 1',
      'before_results',
      '{}'::jsonb,
      'user-acme-owner'
    )
  `);

  await db.query(`
    INSERT INTO questions (
      id,
      assessment_version_id,
      type,
      prompt,
      is_required,
      position,
      weight,
      metadata
    )
    VALUES (
      '00000000-0000-4000-8200-000000001111',
      '00000000-0000-4000-8100-000000001111',
      'single_choice',
      'How mature is your go-to-market?',
      TRUE,
      1,
      1,
      '{}'::jsonb
    )
  `);

  await db.query(`
    INSERT INTO leads (
      id,
      tenant_id,
      assessment_id,
      email,
      first_name,
      last_name,
      consent,
      consent_at,
      source_utm
    )
    VALUES
      (
        '00000000-0000-4000-8530-000000001001',
        'tenant-acme',
        '00000000-0000-4000-8000-000000001111',
        'ada@example.com',
        'Ada',
        'Lovelace',
        TRUE,
        now(),
        '{}'::jsonb
      ),
      (
        '00000000-0000-4000-8530-000000001002',
        'tenant-acme',
        '00000000-0000-4000-8000-000000001111',
        'grace@example.com',
        'Grace',
        'Hopper',
        TRUE,
        now(),
        '{}'::jsonb
      )
  `);

  await db.query(`
    INSERT INTO sessions (
      id,
      assessment_id,
      assessment_version_id,
      lead_id,
      status,
      current_question_position,
      started_at,
      completed_at,
      runtime_context
    )
    VALUES
      (
        '00000000-0000-4000-8600-000000001001',
        '00000000-0000-4000-8000-000000001111',
        '00000000-0000-4000-8100-000000001111',
        '00000000-0000-4000-8530-000000001001',
        'completed',
        NULL,
        now() - interval '1 day',
        now() - interval '1 day',
        '{}'::jsonb
      ),
      (
        '00000000-0000-4000-8600-000000001002',
        '00000000-0000-4000-8000-000000001111',
        '00000000-0000-4000-8100-000000001111',
        '00000000-0000-4000-8530-000000001002',
        'in_progress',
        1,
        now() - interval '1 day',
        NULL,
        '{}'::jsonb
      )
  `);

  await db.query(`
    INSERT INTO responses (
      id,
      session_id,
      question_id,
      answer_json,
      computed_score,
      answered_at
    )
    VALUES
      (
        '00000000-0000-4000-8700-000000001001',
        '00000000-0000-4000-8600-000000001001',
        '00000000-0000-4000-8200-000000001111',
        '"advanced"'::jsonb,
        5,
        now() - interval '1 day'
      ),
      (
        '00000000-0000-4000-8700-000000001002',
        '00000000-0000-4000-8600-000000001002',
        '00000000-0000-4000-8200-000000001111',
        '"beginner"'::jsonb,
        1,
        now() - interval '1 day'
      )
  `);

  await db.query(`
    INSERT INTO results (
      id,
      session_id,
      raw_score,
      normalized_score,
      max_possible_raw_score,
      breakdown,
      recommendations,
      generated_report,
      finalized_at
    )
    VALUES (
      '00000000-0000-4000-8800-000000001001',
      '00000000-0000-4000-8600-000000001001',
      5,
      88,
      6,
      '{}'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb,
      now() - interval '1 day'
    )
  `);

  await db.query(`
    INSERT INTO analytics_daily_assessment (
      tenant_id,
      assessment_id,
      date_key,
      visits,
      starts,
      completions,
      leads,
      avg_score
    )
    VALUES (
      'tenant-acme',
      '00000000-0000-4000-8000-000000001111',
      current_date - interval '1 day',
      5,
      2,
      1,
      2,
      88
    )
  `);
}

async function createTestContext(): Promise<TestContext> {
  const db = createInMemoryDatabaseClient();
  await seedSchema(db);

  const specPath = path.resolve(process.cwd(), '../../specs/api/openapi.yaml');
  const openApi = await createOpenApiValidationProvider({ specPath });

  const app = await buildServer({
    env: TEST_ENV,
    db,
    openApi
  });
  await app.ready();

  return { app, db };
}

async function closeTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.db.close();
}

async function loginAsOwner(app: FastifyInstance): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      email: 'owner@acme.example',
      password: 'ChangeMe123!',
      tenantSlug: 'acme'
    }
  });

  assert.equal(login.statusCode, 200, login.body);
  const auth = login.json() as { accessToken: string };
  return auth.accessToken;
}

test('reports endpoints support template and section lifecycle', async () => {
  const context = await createTestContext();
  try {
    const token = await loginAsOwner(context.app);

    const getTemplate = await context.app.inject({
      method: 'GET',
      url: '/v1/versions/00000000-0000-4000-8100-000000001111/report-template',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(getTemplate.statusCode, 200, getTemplate.body);
    const initialTemplate = getTemplate.json() as { id: string; title: string; sections: unknown[] };
    assert.equal(initialTemplate.title, 'Growth Version 1 Report');
    assert.equal(initialTemplate.sections.length, 0);

    const upsertTemplate = await context.app.inject({
      method: 'PUT',
      url: '/v1/versions/00000000-0000-4000-8100-000000001111/report-template',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: 'Executive Snapshot',
        headerContent: { logo: 'https://cdn.example/logo.png' },
        footerContent: { disclaimer: 'Confidential' }
      }
    });
    assert.equal(upsertTemplate.statusCode, 200, upsertTemplate.body);
    const template = upsertTemplate.json() as { id: string; title: string };
    assert.equal(template.title, 'Executive Snapshot');

    const createSection = await context.app.inject({
      method: 'POST',
      url: `/v1/report-templates/${template.id}/sections`,
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        sectionKey: 'summary',
        title: 'Summary',
        bodyTemplate: 'Your score is {{score}}',
        displayCondition: { minScore: 50 },
        position: 1
      }
    });
    assert.equal(createSection.statusCode, 201, createSection.body);
    const section = createSection.json() as { id: string; title: string; position: number };
    assert.equal(section.title, 'Summary');
    assert.equal(section.position, 1);

    const createDuplicateSection = await context.app.inject({
      method: 'POST',
      url: `/v1/report-templates/${template.id}/sections`,
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        sectionKey: 'summary',
        title: 'Duplicate Summary',
        bodyTemplate: 'Duplicate',
        position: 2
      }
    });
    assert.equal(createDuplicateSection.statusCode, 409, createDuplicateSection.body);
    const duplicateBody = createDuplicateSection.json() as { code: string; message: string };
    assert.match(duplicateBody.code, /CONFLICT|REPORT_SECTION_KEY_CONFLICT/);
    assert.match(duplicateBody.message, /conflict|section/i);

    const updateSection = await context.app.inject({
      method: 'PATCH',
      url: `/v1/report-sections/${section.id}`,
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: 'Updated Summary',
        position: 2
      }
    });
    assert.equal(updateSection.statusCode, 200, updateSection.body);
    const updated = updateSection.json() as { title: string; position: number };
    assert.equal(updated.title, 'Updated Summary');
    assert.equal(updated.position, 2);

    const deleteSection = await context.app.inject({
      method: 'DELETE',
      url: `/v1/report-sections/${section.id}`,
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(deleteSection.statusCode, 204, deleteSection.body);

    const getTemplateAfterDelete = await context.app.inject({
      method: 'GET',
      url: '/v1/versions/00000000-0000-4000-8100-000000001111/report-template',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(getTemplateAfterDelete.statusCode, 200, getTemplateAfterDelete.body);
    const afterDelete = getTemplateAfterDelete.json() as { sections: unknown[] };
    assert.equal(afterDelete.sections.length, 0);
  } finally {
    await closeTestContext(context);
  }
});

test('analytics summary and dropoff return computed metrics', async () => {
  const context = await createTestContext();
  try {
    const token = await loginAsOwner(context.app);

    const summary = await context.app.inject({
      method: 'GET',
      url: '/v1/analytics/assessments/00000000-0000-4000-8000-000000001111/summary',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(summary.statusCode, 200, summary.body);
    const summaryBody = summary.json() as {
      starts: number;
      completions: number;
      leads: number;
      visits: number;
      conversionRate: number;
      averageScore: number;
    };
    assert.equal(summaryBody.starts, 2);
    assert.equal(summaryBody.completions, 1);
    assert.equal(summaryBody.leads, 2);
    assert.equal(summaryBody.visits, 5);
    assert.equal(summaryBody.conversionRate, 0.5);
    assert.equal(summaryBody.averageScore, 88);

    const dropoff = await context.app.inject({
      method: 'GET',
      url: '/v1/analytics/assessments/00000000-0000-4000-8000-000000001111/dropoff',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(dropoff.statusCode, 200, dropoff.body);
    const dropoffBody = dropoff.json() as {
      data: Array<{ questionId: string; views: number; exits: number; dropoffRate: number }>;
    };
    assert.equal(dropoffBody.data.length, 1);
    assert.equal(dropoffBody.data[0]?.questionId, '00000000-0000-4000-8200-000000001111');
    assert.equal(dropoffBody.data[0]?.views, 2);
    assert.equal(dropoffBody.data[0]?.exits, 1);
    assert.equal(dropoffBody.data[0]?.dropoffRate, 0.5);
  } finally {
    await closeTestContext(context);
  }
});

test('integrations endpoints support webhook CRUD and lead CSV export', async () => {
  const context = await createTestContext();
  try {
    const token = await loginAsOwner(context.app);

    const createWebhook = await context.app.inject({
      method: 'POST',
      url: '/v1/integrations/webhooks',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        name: 'Primary CRM',
        targetUrl: 'https://hooks.example/crm',
        secret: 'super-secret-123',
        subscribedEvents: ['lead.created', 'session.completed']
      }
    });
    assert.equal(createWebhook.statusCode, 201, createWebhook.body);
    const webhook = createWebhook.json() as { id: string; isActive: boolean };
    assert.equal(webhook.isActive, true);

    const storedSecret = await context.db.query<{ secret: string }>(
      `
        SELECT secret_encrypted AS secret
        FROM webhook_endpoints
        WHERE id = $1
      `,
      [webhook.id]
    );
    assert.match(storedSecret.rows[0]?.secret ?? '', /^enc:v1:/);
    assert.notEqual(storedSecret.rows[0]?.secret, 'super-secret-123');

    const updateWebhook = await context.app.inject({
      method: 'PATCH',
      url: `/v1/integrations/webhooks/${webhook.id}`,
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        isActive: false,
        subscribedEvents: ['lead.created']
      }
    });
    assert.equal(updateWebhook.statusCode, 200, updateWebhook.body);
    const updatedWebhook = updateWebhook.json() as { isActive: boolean; subscribedEvents: string[] };
    assert.equal(updatedWebhook.isActive, false);
    assert.equal(updatedWebhook.subscribedEvents.length, 1);
    assert.equal(updatedWebhook.subscribedEvents[0], 'lead.created');

    const listWebhooks = await context.app.inject({
      method: 'GET',
      url: '/v1/integrations/webhooks',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(listWebhooks.statusCode, 200, listWebhooks.body);
    const listBody = listWebhooks.json() as { data: Array<{ id: string }> };
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0]?.id, webhook.id);

    const exportCsv = await context.app.inject({
      method: 'GET',
      url: '/v1/assessments/00000000-0000-4000-8000-000000001111/leads/export',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(exportCsv.statusCode, 200, exportCsv.body);
    assert.match(exportCsv.headers['content-type'] ?? '', /text\/csv/i);
    assert.match(exportCsv.body, /leadId,email,firstName,lastName/);
    assert.match(exportCsv.body, /ada@example.com/);
    assert.match(exportCsv.body, /grace@example.com/);

    const deleteWebhook = await context.app.inject({
      method: 'DELETE',
      url: `/v1/integrations/webhooks/${webhook.id}`,
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(deleteWebhook.statusCode, 204, deleteWebhook.body);

    const listAfterDelete = await context.app.inject({
      method: 'GET',
      url: '/v1/integrations/webhooks',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(listAfterDelete.statusCode, 200, listAfterDelete.body);
    const listAfterDeleteBody = listAfterDelete.json() as { data: unknown[] };
    assert.equal(listAfterDeleteBody.data.length, 0);
  } finally {
    await closeTestContext(context);
  }
});
