import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { DataType, newDb } from 'pg-mem';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { EnvConfig } from '../../src/config/env.js';
import { runPdfWorker } from '../../src/jobs/pdf-worker.js';
import { runWebhookReplayWorker } from '../../src/jobs/webhook-replay-worker.js';
import { runWebhookWorker } from '../../src/jobs/webhook-worker.js';
import type { DatabaseClient } from '../../src/lib/db.js';
import { createOpenApiValidationProvider } from '../../src/lib/openapi.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';

const TEST_ENV: EnvConfig = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgres://unused-for-tests',
  corsAllowedOrigins: '*',
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
    CREATE TYPE pdf_job_status AS ENUM ('queued', 'processing', 'completed', 'failed');
    CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'sent', 'failed', 'dead_letter');

    CREATE SEQUENCE lead_id_seq START 1;
    CREATE SEQUENCE session_id_seq START 1;
    CREATE SEQUENCE response_id_seq START 1;
    CREATE SEQUENCE result_id_seq START 1;
    CREATE SEQUENCE pdf_job_id_seq START 1;
    CREATE SEQUENCE webhook_endpoint_id_seq START 1;
    CREATE SEQUENCE webhook_event_id_seq START 1;
    CREATE SEQUENCE webhook_delivery_id_seq START 1;
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
    CREATE TABLE landing_pages (
      id TEXT PRIMARY KEY,
      assessment_version_id TEXT NOT NULL UNIQUE REFERENCES assessment_versions(id) ON DELETE CASCADE,
      seo_title TEXT,
      seo_description TEXT,
      theme JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE page_blocks (
      id TEXT PRIMARY KEY,
      landing_page_id TEXT NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      position INTEGER NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_visible BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (landing_page_id, position)
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (assessment_version_id, position)
    )
  `);

  await db.query(`
    CREATE TABLE answer_options (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      score_value NUMERIC(12,4) NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (question_id, position)
    )
  `);

  await db.query(`
    CREATE TABLE logic_rules (
      id TEXT PRIMARY KEY,
      assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      if_expression JSONB NOT NULL,
      then_action JSONB NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE score_bands (
      id TEXT PRIMARY KEY,
      assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      min_score NUMERIC(6,2) NOT NULL,
      max_score NUMERIC(6,2) NOT NULL,
      color_hex TEXT,
      summary TEXT,
      recommendation_template TEXT,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE report_templates (
      id TEXT PRIMARY KEY,
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
      id TEXT PRIMARY KEY,
      report_template_id TEXT NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
      section_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body_template TEXT NOT NULL,
      display_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT report_sections_template_position_unique UNIQUE (report_template_id, position),
      CONSTRAINT report_sections_template_key_unique UNIQUE (report_template_id, section_key)
    )
  `);

  await db.query(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8500-' || lpad(nextval('lead_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8600-' || lpad(nextval('session_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8700-' || lpad(nextval('response_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8800-' || lpad(nextval('result_id_seq')::text, 12, '0')),
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      score_band_id TEXT REFERENCES score_bands(id) ON DELETE SET NULL,
      raw_score NUMERIC(12,4) NOT NULL DEFAULT 0,
      normalized_score NUMERIC(6,2) NOT NULL DEFAULT 0,
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
    CREATE TABLE pdf_jobs (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8900-' || lpad(nextval('pdf_job_id_seq')::text, 12, '0')),
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status pdf_job_status NOT NULL DEFAULT 'queued',
      storage_key TEXT,
      file_url TEXT,
      requested_by_email TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE webhook_endpoints (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8520-' || lpad(nextval('webhook_endpoint_id_seq')::text, 12, '0')),
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
    CREATE TABLE webhook_events (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-9000-' || lpad(nextval('webhook_event_id_seq')::text, 12, '0')),
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      dedupe_key TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-9010-' || lpad(nextval('webhook_delivery_id_seq')::text, 12, '0')),
      webhook_event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
      webhook_endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      status webhook_delivery_status NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TIMESTAMPTZ,
      last_http_status INTEGER,
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT webhook_deliveries_event_endpoint_unique UNIQUE (webhook_event_id, webhook_endpoint_id)
    )
  `);

  const passwordHash = await hashPassword('ChangeMe123!');

  await db.query(`
    INSERT INTO tenants (id, name, slug, status)
    VALUES ('00000000-0000-4000-7000-000000009001', 'Acme Advisory', 'acme', 'active')
  `);

  await db.query(
    `
      INSERT INTO users (id, tenant_id, email, password_hash, role, status, first_name, last_name)
      VALUES (
        '00000000-0000-4000-7100-000000009001',
        '00000000-0000-4000-7000-000000009001',
        'owner@acme.example',
        $1,
        'owner',
        'active',
        'Acme',
        'Owner'
      )
    `,
    [passwordHash]
  );

  await db.query(`
    INSERT INTO assessments (
      id,
      tenant_id,
      name,
      slug,
      status,
      created_by
    )
    VALUES (
      '00000000-0000-4000-8000-000000009001',
      '00000000-0000-4000-7000-000000009001',
      'E2E Growth Assessment',
      'e2e-growth',
      'published',
      '00000000-0000-4000-7100-000000009001'
    )
  `);

  await db.query(`
    INSERT INTO assessment_versions (
      id,
      assessment_id,
      version_no,
      is_published,
      published_at,
      title,
      lead_capture_mode,
      runtime_settings,
      created_by
    )
    VALUES (
      '00000000-0000-4000-8100-000000009001',
      '00000000-0000-4000-8000-000000009001',
      1,
      TRUE,
      now(),
      'Published V1',
      'before_results',
      '{}'::jsonb,
      '00000000-0000-4000-7100-000000009001'
    )
  `);

  await db.query(`
    INSERT INTO landing_pages (
      id,
      assessment_version_id,
      seo_title,
      seo_description,
      theme
    )
    VALUES (
      '00000000-0000-4000-8150-000000009001',
      '00000000-0000-4000-8100-000000009001',
      'E2E Landing',
      'Run an end-to-end assessment',
      '{}'::jsonb
    )
  `);

  await db.query(`
    INSERT INTO page_blocks (
      id,
      landing_page_id,
      type,
      position,
      config,
      is_visible
    )
    VALUES (
      '00000000-0000-4000-8160-000000009001',
      '00000000-0000-4000-8150-000000009001',
      'hero',
      1,
      '{"title":"E2E Growth"}'::jsonb,
      TRUE
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
      '00000000-0000-4000-8200-000000009001',
      '00000000-0000-4000-8100-000000009001',
      'single_choice',
      'How advanced is your growth engine?',
      TRUE,
      1,
      2,
      '{}'::jsonb
    )
  `);

  await db.query(`
    INSERT INTO answer_options (
      id,
      question_id,
      label,
      value,
      score_value,
      position,
      metadata
    )
    VALUES
      (
        '00000000-0000-4000-8300-000000009001',
        '00000000-0000-4000-8200-000000009001',
        'Advanced',
        'advanced',
        3,
        1,
        '{}'::jsonb
      ),
      (
        '00000000-0000-4000-8300-000000009002',
        '00000000-0000-4000-8200-000000009001',
        'Basic',
        'basic',
        1,
        2,
        '{}'::jsonb
      )
  `);

  await db.query(`
    INSERT INTO logic_rules (
      id,
      assessment_version_id,
      name,
      priority,
      if_expression,
      then_action,
      is_active
    )
    VALUES (
      '00000000-0000-4000-8400-000000009001',
      '00000000-0000-4000-8100-000000009001',
      'Tag advanced',
      1,
      '{"questionId":"00000000-0000-4000-8200-000000009001","equals":"advanced"}'::jsonb,
      '{"action":"tag","tag":"advanced"}'::jsonb,
      TRUE
    )
  `);

  await db.query(`
    INSERT INTO score_bands (
      id,
      assessment_version_id,
      label,
      min_score,
      max_score,
      summary,
      recommendation_template,
      position
    )
    VALUES (
      '00000000-0000-4000-8170-000000009001',
      '00000000-0000-4000-8100-000000009001',
      'Top Performer',
      0,
      100,
      'Strong execution',
      'Keep scaling your strongest channel.',
      1
    )
  `);

  await db.query(`
    INSERT INTO report_templates (
      id,
      assessment_version_id,
      title,
      header_content,
      footer_content
    )
    VALUES (
      '00000000-0000-4000-8500-000000009001',
      '00000000-0000-4000-8100-000000009001',
      'Published Report',
      '{}'::jsonb,
      '{}'::jsonb
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

test('published versions are immutable for report mutations', async () => {
  const context = await createTestContext();
  try {
    const token = await loginAsOwner(context.app);

    const updateTemplate = await context.app.inject({
      method: 'PUT',
      url: '/v1/versions/00000000-0000-4000-8100-000000009001/report-template',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: 'Should Fail'
      }
    });
    assert.equal(updateTemplate.statusCode, 409, updateTemplate.body);
    const updateBody = updateTemplate.json() as { code: string };
    assert.equal(updateBody.code, 'VERSION_PUBLISHED');

    const createSection = await context.app.inject({
      method: 'POST',
      url: '/v1/report-templates/00000000-0000-4000-8500-000000009001/sections',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        sectionKey: 'new',
        title: 'New Section',
        bodyTemplate: 'Body',
        position: 1
      }
    });
    assert.equal(createSection.statusCode, 409, createSection.body);
    const createBody = createSection.json() as { code: string };
    assert.equal(createBody.code, 'VERSION_PUBLISHED');
  } finally {
    await closeTestContext(context);
  }
});

test('end-to-end flow: runtime -> completion -> pdf worker -> webhook dead-letter replay -> CSV export/report retrieval', async () => {
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
        name: 'E2E Listener',
        targetUrl: 'https://webhook.example/e2e',
        secret: 'super-secret-value',
        subscribedEvents: ['lead.created', 'session.completed', 'pdf.generated']
      }
    });
    assert.equal(createWebhook.statusCode, 201, createWebhook.body);

    const bootstrap = await context.app.inject({
      method: 'GET',
      url: '/v1/public/e2e-growth/bootstrap'
    });
    assert.equal(bootstrap.statusCode, 200, bootstrap.body);
    const bootstrapBody = bootstrap.json() as {
      questions: Array<{ id: string }>;
    };
    const questionId = bootstrapBody.questions[0]?.id;
    assert.equal(questionId, '00000000-0000-4000-8200-000000009001');

    const start = await context.app.inject({
      method: 'POST',
      url: '/v1/public/e2e-growth/sessions',
      payload: {
        utm: {
          source: 'e2e-test'
        }
      }
    });
    assert.equal(start.statusCode, 201, start.body);
    const session = start.json() as { id: string };

    const lead = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/lead`,
      headers: {
        'idempotency-key': 'e2e-lead-1'
      },
      payload: {
        email: 'e2e@example.com',
        firstName: 'E2E',
        lastName: 'Tester',
        consent: true
      }
    });
    assert.equal(lead.statusCode, 200, lead.body);

    const response = await context.app.inject({
      method: 'PUT',
      url: `/v1/sessions/${session.id}/responses`,
      headers: {
        'idempotency-key': 'e2e-response-1'
      },
      payload: {
        questionId,
        answer: 'advanced'
      }
    });
    assert.equal(response.statusCode, 200, response.body);

    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/complete`,
      headers: {
        'idempotency-key': 'e2e-complete-1'
      },
      payload: {}
    });
    assert.equal(complete.statusCode, 200, complete.body);
    const completeBody = complete.json() as { normalizedScore: number };
    assert.equal(completeBody.normalizedScore, 100);

    const queuePdf = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/pdf`,
      payload: {
        emailTo: 'e2e@example.com'
      }
    });
    assert.equal(queuePdf.statusCode, 202, queuePdf.body);
    const pdfJob = queuePdf.json() as { id: string; status: string };
    assert.equal(pdfJob.status, 'queued');

    const pdfRun = await runPdfWorker({
      db: context.db,
      batchSize: 10,
      publicBaseUrl: 'https://files.e2e.local'
    });
    assert.equal(pdfRun.processed, 1);
    assert.equal(pdfRun.completed, 1);

    const pdfStatus = await context.app.inject({
      method: 'GET',
      url: `/v1/pdf-jobs/${pdfJob.id}`
    });
    assert.equal(pdfStatus.statusCode, 200, pdfStatus.body);
    const pdfStatusBody = pdfStatus.json() as { status: string; fileUrl?: string };
    assert.equal(pdfStatusBody.status, 'completed');
    assert.match(pdfStatusBody.fileUrl ?? '', /^https:\/\/files\.e2e\.local\//);

    const pendingDeliveries = await context.db.query<{ count: string | number }>(
      `
        SELECT COUNT(*) AS count
        FROM webhook_deliveries
        WHERE status = 'pending'
      `
    );
    assert.equal(Number(pendingDeliveries.rows[0]?.count ?? 0), 3);

    let failSessionCompleted = true;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const eventType = headers?.['x-qassess-event'] ?? headers?.['X-QAssess-Event'];

      if (eventType === 'session.completed' && failSessionCompleted) {
        return new Response('temporary failure', { status: 500 });
      }

      return new Response('ok', { status: 202 });
    };

    const firstWebhookRun = await runWebhookWorker({
      db: context.db,
      batchSize: 20,
      maxAttempts: 1,
      secretDecryptionKey: TEST_ENV.webhookSecretEncryptionKey,
      fetchImpl
    });
    assert.equal(firstWebhookRun.processed, 3);
    assert.equal(firstWebhookRun.sent, 2);
    assert.equal(firstWebhookRun.failed, 0);
    assert.equal(firstWebhookRun.deadLetter, 1);

    const deadLetterRow = await context.db.query<{ id: string; attemptCount: string | number }>(
      `
        SELECT
          id,
          attempt_count AS "attemptCount"
        FROM webhook_deliveries
        WHERE status = 'dead_letter'
        LIMIT 1
      `
    );
    const deadLetterId = deadLetterRow.rows[0]?.id;
    assert.ok(deadLetterId);
    assert.equal(Number(deadLetterRow.rows[0]?.attemptCount ?? 0), 1);

    const replayRun = await runWebhookReplayWorker({
      db: context.db,
      limit: 10
    });
    assert.equal(replayRun.selected, 1);
    assert.equal(replayRun.replayed, 1);

    const replayedStatus = await context.db.query<{
      status: string;
      attemptCount: string | number;
      nextRetryAt: Date | string | null;
    }>(
      `
        SELECT
          status::text AS status,
          attempt_count AS "attemptCount",
          next_retry_at AS "nextRetryAt"
        FROM webhook_deliveries
        WHERE id = $1
        LIMIT 1
      `,
      [deadLetterId]
    );
    assert.equal(replayedStatus.rows[0]?.status, 'failed');
    assert.equal(Number(replayedStatus.rows[0]?.attemptCount ?? 0), 0);
    assert.ok(replayedStatus.rows[0]?.nextRetryAt);

    failSessionCompleted = false;

    const secondWebhookRun = await runWebhookWorker({
      db: context.db,
      batchSize: 20,
      maxAttempts: 3,
      secretDecryptionKey: TEST_ENV.webhookSecretEncryptionKey,
      fetchImpl
    });
    assert.equal(secondWebhookRun.processed, 1);
    assert.equal(secondWebhookRun.sent, 1);
    assert.equal(secondWebhookRun.failed, 0);
    assert.equal(secondWebhookRun.deadLetter, 0);

    const deliveryStatus = await context.db.query<{ status: string; count: string | number }>(
      `
        SELECT status::text AS status, COUNT(*) AS count
        FROM webhook_deliveries
        GROUP BY status
      `
    );
    const byStatus = new Map(deliveryStatus.rows.map((row) => [row.status, Number(row.count)]));
    assert.equal(byStatus.get('sent'), 3);
    assert.equal(byStatus.get('dead_letter') ?? 0, 0);

    const exportCsv = await context.app.inject({
      method: 'GET',
      url: '/v1/assessments/00000000-0000-4000-8000-000000009001/leads/export',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(exportCsv.statusCode, 200, exportCsv.body);
    assert.match(exportCsv.body, /e2e@example\.com/);
    assert.match(exportCsv.body, /100/);

    const reportTemplate = await context.app.inject({
      method: 'GET',
      url: '/v1/versions/00000000-0000-4000-8100-000000009001/report-template',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(reportTemplate.statusCode, 200, reportTemplate.body);
    const reportBody = reportTemplate.json() as { id: string; title: string };
    assert.equal(reportBody.id, '00000000-0000-4000-8500-000000009001');
    assert.equal(reportBody.title, 'Published Report');
  } finally {
    await closeTestContext(context);
  }
});
