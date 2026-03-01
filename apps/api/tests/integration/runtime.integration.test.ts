import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { DataType, newDb } from 'pg-mem';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { EnvConfig } from '../../src/config/env.js';
import type { DatabaseClient } from '../../src/lib/db.js';
import { createOpenApiValidationProvider } from '../../src/lib/openapi.js';
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

async function seedRuntimeSchema(db: DatabaseClient): Promise<void> {
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
    CREATE TABLE assessments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status assessment_status NOT NULL DEFAULT 'draft',
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, slug)
    )
  `);

  await db.query(`
    CREATE TABLE assessment_versions (
      id TEXT PRIMARY KEY,
      assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL CHECK (version_no >= 1),
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      published_at TIMESTAMPTZ,
      title TEXT NOT NULL,
      intro_copy TEXT,
      outro_copy TEXT,
      lead_capture_mode TEXT NOT NULL DEFAULT 'before_results',
      lead_capture_step INTEGER,
      runtime_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
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
      id TEXT PRIMARY KEY,
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
      UNIQUE (webhook_event_id, webhook_endpoint_id)
    )
  `);

  await db.query(`
    CREATE TABLE audit_logs (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    INSERT INTO tenants (id, name, slug, status)
    VALUES ('00000000-0000-4000-7000-000000000001', 'Acme Advisory', 'acme', 'active');

    INSERT INTO assessments (id, tenant_id, name, slug, status)
    VALUES ('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-7000-000000000001', 'Public Growth Score', 'public-growth', 'published');

    INSERT INTO assessment_versions (
      id,
      assessment_id,
      version_no,
      is_published,
      published_at,
      title,
      lead_capture_mode,
      runtime_settings
    )
    VALUES (
      '00000000-0000-4000-8100-000000000100',
      '00000000-0000-4000-8000-000000000100',
      1,
      TRUE,
      now(),
      'V1',
      'before_results',
      '{}'::jsonb
    );

    INSERT INTO landing_pages (
      id,
      assessment_version_id,
      seo_title,
      seo_description,
      theme
    )
    VALUES (
      '00000000-0000-4000-8150-000000000100',
      '00000000-0000-4000-8100-000000000100',
      'Public Growth Assessment',
      'Find your growth bottlenecks',
      '{"palette":"sunset"}'::jsonb
    );

    INSERT INTO page_blocks (
      id,
      landing_page_id,
      type,
      position,
      config,
      is_visible
    )
    VALUES (
      '00000000-0000-4000-8160-000000000100',
      '00000000-0000-4000-8150-000000000100',
      'hero',
      1,
      '{"headline":"Scale Smarter"}'::jsonb,
      TRUE
    );

    INSERT INTO questions (
      id,
      assessment_version_id,
      type,
      prompt,
      position,
      weight,
      metadata
    )
    VALUES (
      '00000000-0000-4000-8200-000000000100',
      '00000000-0000-4000-8100-000000000100',
      'multi_choice',
      'How mature is your pipeline?',
      1,
      2,
      '{}'::jsonb
    );

    INSERT INTO answer_options (
      id,
      question_id,
      label,
      value,
      score_value,
      position,
      metadata
    )
    VALUES (
      '00000000-0000-4000-8300-000000000100',
      '00000000-0000-4000-8200-000000000100',
      'Advanced',
      'advanced',
      3,
      1,
      '{}'::jsonb
    );

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
      '00000000-0000-4000-8400-000000000100',
      '00000000-0000-4000-8100-000000000100',
      'Sample Rule',
      1,
      '{"questionId":"00000000-0000-4000-8200-000000000100","equals":"advanced"}'::jsonb,
      '{"action":"tag","tag":"ready"}'::jsonb,
      TRUE
    );

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
      '00000000-0000-4000-8170-000000000100',
      '00000000-0000-4000-8100-000000000100',
      'Top Performer',
      0,
      100,
      'Strong execution',
      'Keep scaling your strongest channel.',
      1
    );
  `);
}

async function createTestContext(envOverride?: Partial<EnvConfig>): Promise<TestContext> {
  const db = createInMemoryDatabaseClient();
  await seedRuntimeSchema(db);

  const specPath = path.resolve(process.cwd(), '../../specs/api/openapi.yaml');
  const openApi = await createOpenApiValidationProvider({ specPath });

  const app = await buildServer({
    env: {
      ...TEST_ENV,
      ...envOverride
    },
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

test('public runtime flow covers bootstrap, session, lead, responses, completion, and pdf queue', async () => {
  const context = await createTestContext();
  try {
    const bootstrapRes = await context.app.inject({
      method: 'GET',
      url: '/v1/public/public-growth/bootstrap'
    });

    assert.equal(bootstrapRes.statusCode, 200);
    const bootstrap = bootstrapRes.json() as {
      assessmentId: string;
      assessmentVersionId: string;
      landing: { seoTitle?: string; blocks: Array<{ id: string; type: string }> };
      questions: Array<{ id: string; prompt: string }>;
      logicRules: Array<{ id: string }>;
      leadCaptureMode: string;
    };
    assert.equal(bootstrap.assessmentId, '00000000-0000-4000-8000-000000000100');
    assert.equal(bootstrap.assessmentVersionId, '00000000-0000-4000-8100-000000000100');
    assert.equal(bootstrap.landing.seoTitle, 'Public Growth Assessment');
    assert.equal(bootstrap.landing.blocks.length, 1);
    assert.equal(bootstrap.questions.length, 1);
    assert.equal(bootstrap.logicRules.length, 1);
    assert.equal(bootstrap.leadCaptureMode, 'before_results');

    const startSessionRes = await context.app.inject({
      method: 'POST',
      url: '/v1/public/public-growth/sessions',
      payload: {
        utm: {
          source: 'newsletter',
          medium: 'email'
        }
      }
    });
    assert.equal(startSessionRes.statusCode, 201);
    const session = startSessionRes.json() as {
      id: string;
      assessmentId: string;
      assessmentVersionId: string;
      status: string;
      currentQuestionPosition?: number;
    };
    assert.equal(session.assessmentId, bootstrap.assessmentId);
    assert.equal(session.assessmentVersionId, bootstrap.assessmentVersionId);
    assert.equal(session.status, 'in_progress');
    assert.equal(session.currentQuestionPosition, 1);

    const upsertLeadRes = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/lead`,
      headers: {
        'idempotency-key': 'lead-upsert-001'
      },
      payload: {
        email: 'person@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        company: 'Analytical Engines',
        consent: true
      }
    });
    assert.equal(upsertLeadRes.statusCode, 200, upsertLeadRes.body);
    const lead = upsertLeadRes.json() as { id: string; email?: string; consent: boolean; tenantId: string };
    assert.equal(lead.email, 'person@example.com');
    assert.equal(lead.consent, true);
    assert.equal(lead.tenantId, '00000000-0000-4000-7000-000000000001');
    assert.ok(lead.id.length > 10);

    const upsertResponseRes = await context.app.inject({
      method: 'PUT',
      url: `/v1/sessions/${session.id}/responses`,
      headers: {
        'idempotency-key': 'response-upsert-001'
      },
      payload: {
        questionId: bootstrap.questions[0]?.id,
        answer: ['advanced']
      }
    });
    assert.equal(upsertResponseRes.statusCode, 200, upsertResponseRes.body);
    const response = upsertResponseRes.json() as { computedScore: number; answer: string[] };
    assert.equal(response.answer[0], 'advanced');
    assert.equal(response.computedScore, 6);

    const completeRes = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/complete`,
      headers: {
        'idempotency-key': 'complete-001'
      },
      payload: {}
    });
    assert.equal(completeRes.statusCode, 200, completeRes.body);
    const result = completeRes.json() as {
      sessionId: string;
      rawScore: number;
      normalizedScore: number;
      maxPossibleRawScore: number;
      scoreBand?: { label?: string };
      recommendations?: string[];
    };
    assert.equal(result.sessionId, session.id);
    assert.equal(result.rawScore, 6);
    assert.equal(result.maxPossibleRawScore, 6);
    assert.equal(result.normalizedScore, 100);
    assert.equal(result.scoreBand?.label, 'Top Performer');
    assert.equal(result.recommendations?.[0], 'Keep scaling your strongest channel.');

    const getResultRes = await context.app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}/result`
    });
    assert.equal(getResultRes.statusCode, 200);
    const fetched = getResultRes.json() as { sessionId: string; normalizedScore: number };
    assert.equal(fetched.sessionId, session.id);
    assert.equal(fetched.normalizedScore, 100);

    const queuePdfRes = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/pdf`,
      payload: {
        emailTo: 'person@example.com'
      }
    });
    assert.equal(queuePdfRes.statusCode, 202, queuePdfRes.body);
    const job = queuePdfRes.json() as { id: string; status: string; sessionId: string; attemptCount: number };
    assert.equal(job.status, 'queued');
    assert.equal(job.sessionId, session.id);
    assert.equal(job.attemptCount, 0);

    const getPdfRes = await context.app.inject({
      method: 'GET',
      url: `/v1/pdf-jobs/${job.id}`
    });
    assert.equal(getPdfRes.statusCode, 200, getPdfRes.body);
    const fetchedJob = getPdfRes.json() as { id: string; status: string };
    assert.equal(fetchedJob.id, job.id);
    assert.equal(fetchedJob.status, 'queued');
  } finally {
    await closeTestContext(context);
  }
});

test('response upsert rejects question outside session version', async () => {
  const context = await createTestContext();
  try {
    const startSessionRes = await context.app.inject({
      method: 'POST',
      url: '/v1/public/public-growth/sessions',
      payload: {}
    });
    assert.equal(startSessionRes.statusCode, 201);
    const session = startSessionRes.json() as { id: string };

    const badResponse = await context.app.inject({
      method: 'PUT',
      url: `/v1/sessions/${session.id}/responses`,
      headers: {
        'idempotency-key': 'response-upsert-unknown'
      },
      payload: {
        questionId: '00000000-0000-4000-8200-000000000999',
        answer: ['advanced']
      }
    });

    assert.equal(badResponse.statusCode, 422, badResponse.body);
    const body = badResponse.json() as { code: string; message: string };
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.match(body.message, /question/i);
  } finally {
    await closeTestContext(context);
  }
});

test('public/session endpoints enforce configured rate limits', async () => {
  const context = await createTestContext({
    publicBootstrapRateLimitPerMinute: 1,
    publicSessionStartRateLimitPerMinute: 1,
    publicSessionMutationRateLimitPerMinute: 1
  });
  try {
    const firstBootstrap = await context.app.inject({
      method: 'GET',
      url: '/v1/public/public-growth/bootstrap'
    });
    assert.equal(firstBootstrap.statusCode, 200, firstBootstrap.body);

    const secondBootstrap = await context.app.inject({
      method: 'GET',
      url: '/v1/public/public-growth/bootstrap'
    });
    assert.equal(secondBootstrap.statusCode, 429, secondBootstrap.body);
    const bootstrapBody = secondBootstrap.json() as { code: string; details?: { retryAfterSeconds?: number } };
    assert.equal(bootstrapBody.code, 'RATE_LIMITED');
    assert.ok((bootstrapBody.details?.retryAfterSeconds ?? 0) >= 1);

    const startSession = await context.app.inject({
      method: 'POST',
      url: '/v1/public/public-growth/sessions',
      payload: {}
    });
    assert.equal(startSession.statusCode, 201, startSession.body);
    const session = startSession.json() as { id: string };

    const firstLead = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/lead`,
      headers: {
        'idempotency-key': 'limit-lead-1'
      },
      payload: {
        email: 'ratelimit@example.com',
        consent: true
      }
    });
    assert.equal(firstLead.statusCode, 200, firstLead.body);

    const secondLead = await context.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/lead`,
      headers: {
        'idempotency-key': 'limit-lead-2'
      },
      payload: {
        email: 'ratelimit@example.com',
        consent: true
      }
    });
    assert.equal(secondLead.statusCode, 429, secondLead.body);
    const leadBody = secondLead.json() as { code: string };
    assert.equal(leadBody.code, 'RATE_LIMITED');
  } finally {
    await closeTestContext(context);
  }
});
