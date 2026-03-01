import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { DataType, newDb } from 'pg-mem';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { EnvConfig } from '../../src/config/env.js';
import type { DatabaseClient } from '../../src/lib/db.js';
import { hashPassword } from '../../src/lib/password.js';
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

async function seedSchema(db: DatabaseClient): Promise<void> {
  await db.query(`
    CREATE TYPE assessment_status AS ENUM ('draft', 'published', 'archived');
    CREATE TYPE question_type AS ENUM ('single_choice', 'multi_choice', 'scale', 'numeric', 'short_text');
    CREATE SEQUENCE assessments_id_seq START 1;
    CREATE SEQUENCE assessment_versions_id_seq START 1;
    CREATE SEQUENCE landing_pages_id_seq START 1;
    CREATE SEQUENCE page_blocks_id_seq START 1;
    CREATE SEQUENCE questions_id_seq START 1;
    CREATE SEQUENCE answer_options_id_seq START 1;
    CREATE SEQUENCE logic_rules_id_seq START 1;
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8000-' || lpad(nextval('assessments_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8100-' || lpad(nextval('assessment_versions_id_seq')::text, 12, '0')),
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
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (assessment_id, version_no)
    )
  `);

  await db.query(`
    CREATE TABLE landing_pages (
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8150-' || lpad(nextval('landing_pages_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8160-' || lpad(nextval('page_blocks_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8200-' || lpad(nextval('questions_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8300-' || lpad(nextval('answer_options_id_seq')::text, 12, '0')),
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
      id TEXT PRIMARY KEY DEFAULT ('00000000-0000-4000-8400-' || lpad(nextval('logic_rules_id_seq')::text, 12, '0')),
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

  const ownerPassword = await hashPassword('OwnerPass123!');
  const viewerPassword = await hashPassword('ViewerPass123!');

  await db.query(`
    INSERT INTO tenants (id, name, slug, status)
    VALUES ('tenant-acme', 'Acme Advisory', 'acme', 'active')
  `);

  await db.query(
    `
      INSERT INTO users (id, tenant_id, email, password_hash, role, status, first_name, last_name)
      VALUES
        ('user-owner', 'tenant-acme', 'owner@acme.example', $1, 'owner', 'active', 'Owner', 'User'),
        ('user-viewer', 'tenant-acme', 'viewer@acme.example', $2, 'viewer', 'active', 'Viewer', 'User')
    `,
    [ownerPassword, viewerPassword]
  );
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

async function login(app: FastifyInstance, email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      email,
      password,
      tenantSlug: 'acme'
    }
  });

  assert.equal(response.statusCode, 200, `Login failed: ${response.body}`);
  const body = response.json() as { accessToken: string };
  assert.ok(typeof body.accessToken === 'string', `Unexpected login response body: ${response.body}`);
  assert.ok(body.accessToken.length > 30, `Unexpected short token in response: ${response.body}`);
  return body.accessToken;
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`
  };
}

test('Authoring CRUD flow works across assessments, landing, questions, options, and logic rules', async () => {
  const context = await createTestContext();
  try {
    const token = await login(context.app, 'owner@acme.example', 'OwnerPass123!');

    const createAssessment = await context.app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: authHeaders(token),
      payload: {
        name: 'Revenue Health',
        slug: 'revenue-health',
        description: 'Revenue performance baseline'
      }
    });
    assert.equal(createAssessment.statusCode, 201);
    const assessment = createAssessment.json() as { id: string; name: string; slug: string };
    assert.equal(assessment.name, 'Revenue Health');
    assert.equal(assessment.slug, 'revenue-health');

    const listAssessments = await context.app.inject({
      method: 'GET',
      url: '/v1/assessments',
      headers: authHeaders(token)
    });
    assert.equal(listAssessments.statusCode, 200);
    const listed = listAssessments.json() as {
      data: Array<{ id: string }>;
      pagination: { hasMore: boolean; nextCursor?: string };
    };
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]?.id, assessment.id);

    const patchAssessment = await context.app.inject({
      method: 'PATCH',
      url: `/v1/assessments/${assessment.id}`,
      headers: authHeaders(token),
      payload: {
        name: 'Revenue Health Updated'
      }
    });
    assert.equal(patchAssessment.statusCode, 200);
    const patchedAssessment = patchAssessment.json() as { name: string };
    assert.equal(patchedAssessment.name, 'Revenue Health Updated');

    const createVersion = await context.app.inject({
      method: 'POST',
      url: `/v1/assessments/${assessment.id}/versions`,
      headers: authHeaders(token),
      payload: {
        title: 'Version 1'
      }
    });
    assert.equal(createVersion.statusCode, 201);
    const version = createVersion.json() as { id: string; versionNo: number };
    assert.equal(version.versionNo, 1);

    const getLanding = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${version.id}/landing`,
      headers: authHeaders(token)
    });
    assert.equal(getLanding.statusCode, 200);
    const landing = getLanding.json() as { id: string; assessmentVersionId: string; theme: Record<string, unknown>; blocks: unknown[] };
    assert.equal(landing.assessmentVersionId, version.id);
    assert.equal(Array.isArray(landing.blocks), true);
    assert.equal(landing.blocks.length, 0);

    const putLanding = await context.app.inject({
      method: 'PUT',
      url: `/v1/versions/${version.id}/landing`,
      headers: authHeaders(token),
      payload: {
        seoTitle: 'Revenue Health Scorecard',
        seoDescription: 'Benchmark your revenue operations maturity',
        theme: {
          palette: 'sunset',
          font: 'Sora'
        }
      }
    });
    assert.equal(putLanding.statusCode, 200);
    const updatedLanding = putLanding.json() as { id: string; seoTitle?: string; seoDescription?: string; theme: { palette?: string } };
    assert.equal(updatedLanding.id, landing.id);
    assert.equal(updatedLanding.seoTitle, 'Revenue Health Scorecard');
    assert.equal(updatedLanding.seoDescription, 'Benchmark your revenue operations maturity');
    assert.equal(updatedLanding.theme.palette, 'sunset');

    const createBlock = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${version.id}/landing/blocks`,
      headers: authHeaders(token),
      payload: {
        type: 'hero',
        position: 1,
        config: {
          headline: 'Grow faster',
          ctaLabel: 'Start assessment'
        }
      }
    });
    assert.equal(createBlock.statusCode, 201);
    const block = createBlock.json() as { id: string; type: string; isVisible: boolean };
    assert.equal(block.type, 'hero');
    assert.equal(block.isVisible, true);

    const createDuplicateBlock = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${version.id}/landing/blocks`,
      headers: authHeaders(token),
      payload: {
        type: 'social_proof',
        position: 1,
        config: {
          quote: 'Fast setup'
        }
      }
    });
    assert.equal(createDuplicateBlock.statusCode, 409, createDuplicateBlock.body);
    const duplicateBlockBody = createDuplicateBlock.json() as { code: string; message: string };
    assert.match(duplicateBlockBody.code, /LANDING_BLOCK_POSITION_CONFLICT|CONFLICT/);
    assert.match(duplicateBlockBody.message, /landing block position|conflict/i);

    const listBlocks = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${version.id}/landing/blocks`,
      headers: authHeaders(token)
    });
    assert.equal(listBlocks.statusCode, 200);
    const blocksBody = listBlocks.json() as { data: Array<{ id: string }> };
    assert.equal(blocksBody.data.length, 1);
    assert.equal(blocksBody.data[0]?.id, block.id);

    const patchBlock = await context.app.inject({
      method: 'PATCH',
      url: `/v1/landing/blocks/${block.id}`,
      headers: authHeaders(token),
      payload: {
        isVisible: false,
        config: {
          headline: 'Grow much faster',
          ctaLabel: 'Begin now'
        }
      }
    });
    assert.equal(patchBlock.statusCode, 200);
    const patchedBlock = patchBlock.json() as { isVisible: boolean; config: { headline?: string } };
    assert.equal(patchedBlock.isVisible, false);
    assert.equal(patchedBlock.config.headline, 'Grow much faster');

    const createQuestion = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${version.id}/questions`,
      headers: authHeaders(token),
      payload: {
        type: 'single_choice',
        prompt: 'How mature is your revenue process?',
        position: 1,
        weight: 2
      }
    });
    assert.equal(createQuestion.statusCode, 201);
    const question = createQuestion.json() as { id: string; prompt: string };
    assert.equal(question.prompt, 'How mature is your revenue process?');

    const createOption = await context.app.inject({
      method: 'POST',
      url: `/v1/questions/${question.id}/options`,
      headers: authHeaders(token),
      payload: {
        label: 'Early',
        value: 'early',
        scoreValue: 2,
        position: 1
      }
    });
    assert.equal(createOption.statusCode, 201);
    const option = createOption.json() as { id: string; questionId: string };
    assert.equal(option.questionId, question.id);

    const listOptions = await context.app.inject({
      method: 'GET',
      url: `/v1/questions/${question.id}/options`,
      headers: authHeaders(token)
    });
    assert.equal(listOptions.statusCode, 200);
    const optionsBody = listOptions.json() as { data: Array<{ id: string }> };
    assert.equal(optionsBody.data.length, 1);

    const createRule = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${version.id}/logic-rules`,
      headers: authHeaders(token),
      payload: {
        name: 'Skip to follow-up',
        priority: 10,
        ifExpression: {
          questionId: question.id,
          equals: 'early'
        },
        thenAction: {
          action: 'skip_to_position',
          position: 2
        },
        isActive: true
      }
    });
    assert.equal(createRule.statusCode, 201);
    const rule = createRule.json() as { id: string };

    const listRules = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${version.id}/logic-rules`,
      headers: authHeaders(token)
    });
    assert.equal(listRules.statusCode, 200);
    const rulesBody = listRules.json() as { data: Array<{ id: string }> };
    assert.equal(rulesBody.data.length, 1);

    const patchQuestion = await context.app.inject({
      method: 'PATCH',
      url: `/v1/questions/${question.id}`,
      headers: authHeaders(token),
      payload: {
        prompt: 'Updated maturity question'
      }
    });
    assert.equal(patchQuestion.statusCode, 200);
    const patchedQuestion = patchQuestion.json() as { prompt: string };
    assert.equal(patchedQuestion.prompt, 'Updated maturity question');

    const deleteRule = await context.app.inject({
      method: 'DELETE',
      url: `/v1/logic-rules/${rule.id}`,
      headers: authHeaders(token)
    });
    assert.equal(deleteRule.statusCode, 204);

    const deleteOption = await context.app.inject({
      method: 'DELETE',
      url: `/v1/answer-options/${option.id}`,
      headers: authHeaders(token)
    });
    assert.equal(deleteOption.statusCode, 204);

    const deleteBlock = await context.app.inject({
      method: 'DELETE',
      url: `/v1/landing/blocks/${block.id}`,
      headers: authHeaders(token)
    });
    assert.equal(deleteBlock.statusCode, 204);

    const deleteQuestion = await context.app.inject({
      method: 'DELETE',
      url: `/v1/questions/${question.id}`,
      headers: authHeaders(token)
    });
    assert.equal(deleteQuestion.statusCode, 204);
  } finally {
    await closeTestContext(context);
  }
});

test('Published versions are locked and copyFromVersion clones landing/questions/options/logic rules', async () => {
  const context = await createTestContext();
  try {
    const token = await login(context.app, 'owner@acme.example', 'OwnerPass123!');

    const assessmentRes = await context.app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: authHeaders(token),
      payload: {
        name: 'Ops Scorecard',
        slug: 'ops-scorecard'
      }
    });
    assert.equal(assessmentRes.statusCode, 201);
    const assessment = assessmentRes.json() as { id: string; status: string };

    const versionRes = await context.app.inject({
      method: 'POST',
      url: `/v1/assessments/${assessment.id}/versions`,
      headers: authHeaders(token),
      payload: {
        title: 'V1'
      }
    });
    assert.equal(versionRes.statusCode, 201);
    const v1 = versionRes.json() as { id: string };

    const questionRes = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${v1.id}/questions`,
      headers: authHeaders(token),
      payload: {
        type: 'single_choice',
        prompt: 'Where are you in process standardization?',
        position: 1,
        weight: 1
      }
    });
    assert.equal(questionRes.statusCode, 201);
    const q1 = questionRes.json() as { id: string };

    const optionRes = await context.app.inject({
      method: 'POST',
      url: `/v1/questions/${q1.id}/options`,
      headers: authHeaders(token),
      payload: {
        label: 'Ad hoc',
        value: 'adhoc',
        scoreValue: 1,
        position: 1
      }
    });
    assert.equal(optionRes.statusCode, 201);

    const ruleRes = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${v1.id}/logic-rules`,
      headers: authHeaders(token),
      payload: {
        name: 'Rule 1',
        priority: 1,
        ifExpression: { questionId: q1.id, equals: 'adhoc' },
        thenAction: { action: 'tag', tag: 'needs-process' },
        isActive: true
      }
    });
    assert.equal(ruleRes.statusCode, 201);

    const putLandingRes = await context.app.inject({
      method: 'PUT',
      url: `/v1/versions/${v1.id}/landing`,
      headers: authHeaders(token),
      payload: {
        seoTitle: 'Ops Scorecard Landing',
        seoDescription: 'Operational maturity benchmark',
        theme: { accent: 'orange' }
      }
    });
    assert.equal(putLandingRes.statusCode, 200);

    const blockRes = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${v1.id}/landing/blocks`,
      headers: authHeaders(token),
      payload: {
        type: 'hero',
        position: 1,
        config: { headline: 'Operational Excellence' }
      }
    });
    assert.equal(blockRes.statusCode, 201);
    const v1Block = blockRes.json() as { id: string };

    const publishRes = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${v1.id}/publish`,
      headers: authHeaders(token),
      payload: {}
    });
    assert.equal(publishRes.statusCode, 200);
    const published = publishRes.json() as { id: string; isPublished: boolean };
    assert.equal(published.isPublished, true);

    const assessmentAfterPublish = await context.app.inject({
      method: 'GET',
      url: `/v1/assessments/${assessment.id}`,
      headers: authHeaders(token)
    });
    assert.equal(assessmentAfterPublish.statusCode, 200);
    const assessmentBody = assessmentAfterPublish.json() as { status: string };
    assert.equal(assessmentBody.status, 'published');

    const lockedCreateQuestion = await context.app.inject({
      method: 'POST',
      url: `/v1/versions/${v1.id}/questions`,
      headers: authHeaders(token),
      payload: {
        type: 'single_choice',
        prompt: 'Should fail',
        position: 2
      }
    });
    assert.equal(lockedCreateQuestion.statusCode, 409);
    const lockedBody = lockedCreateQuestion.json() as { code: string };
    assert.equal(lockedBody.code, 'VERSION_LOCKED');

    const lockedPatchVersion = await context.app.inject({
      method: 'PATCH',
      url: `/v1/versions/${v1.id}`,
      headers: authHeaders(token),
      payload: {
        title: 'Should fail update'
      }
    });
    assert.equal(lockedPatchVersion.statusCode, 409);

    const lockedPutLanding = await context.app.inject({
      method: 'PUT',
      url: `/v1/versions/${v1.id}/landing`,
      headers: authHeaders(token),
      payload: {
        seoTitle: 'Should fail'
      }
    });
    assert.equal(lockedPutLanding.statusCode, 409);

    const lockedPatchBlock = await context.app.inject({
      method: 'PATCH',
      url: `/v1/landing/blocks/${v1Block.id}`,
      headers: authHeaders(token),
      payload: {
        position: 2
      }
    });
    assert.equal(lockedPatchBlock.statusCode, 409);

    const createV2 = await context.app.inject({
      method: 'POST',
      url: `/v1/assessments/${assessment.id}/versions`,
      headers: authHeaders(token),
      payload: {
        title: 'V2',
        copyFromVersionId: v1.id
      }
    });
    assert.equal(createV2.statusCode, 201);
    const v2 = createV2.json() as { id: string };

    const v2QuestionsRes = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${v2.id}/questions`,
      headers: authHeaders(token)
    });
    assert.equal(v2QuestionsRes.statusCode, 200);
    const v2Questions = v2QuestionsRes.json() as { data: Array<{ id: string }> };
    assert.equal(v2Questions.data.length, 1);
    const clonedQuestionId = v2Questions.data[0]?.id;
    assert.ok(clonedQuestionId);
    assert.notEqual(clonedQuestionId, q1.id);

    const v2OptionsRes = await context.app.inject({
      method: 'GET',
      url: `/v1/questions/${clonedQuestionId}/options`,
      headers: authHeaders(token)
    });
    assert.equal(v2OptionsRes.statusCode, 200);
    const v2Options = v2OptionsRes.json() as { data: Array<{ id: string; value: string }> };
    assert.equal(v2Options.data.length, 1);
    assert.equal(v2Options.data[0]?.value, 'adhoc');

    const v2RulesRes = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${v2.id}/logic-rules`,
      headers: authHeaders(token)
    });
    assert.equal(v2RulesRes.statusCode, 200);
    const v2Rules = v2RulesRes.json() as {
      data: Array<{ id: string; ifExpression: { questionId?: string; equals?: string } }>;
    };
    assert.equal(v2Rules.data.length, 1);
    assert.equal(v2Rules.data[0]?.ifExpression?.questionId, clonedQuestionId);
    assert.equal(v2Rules.data[0]?.ifExpression?.equals, 'adhoc');

    const v2LandingRes = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${v2.id}/landing`,
      headers: authHeaders(token)
    });
    assert.equal(v2LandingRes.statusCode, 200);
    const v2Landing = v2LandingRes.json() as { seoTitle?: string; seoDescription?: string; theme: { accent?: string } };
    assert.equal(v2Landing.seoTitle, 'Ops Scorecard Landing');
    assert.equal(v2Landing.seoDescription, 'Operational maturity benchmark');
    assert.equal(v2Landing.theme.accent, 'orange');

    const v2BlocksRes = await context.app.inject({
      method: 'GET',
      url: `/v1/versions/${v2.id}/landing/blocks`,
      headers: authHeaders(token)
    });
    assert.equal(v2BlocksRes.statusCode, 200);
    const v2Blocks = v2BlocksRes.json() as { data: Array<{ id: string; type: string; config: { headline?: string } }> };
    assert.equal(v2Blocks.data.length, 1);
    assert.equal(v2Blocks.data[0]?.type, 'hero');
    assert.equal(v2Blocks.data[0]?.config.headline, 'Operational Excellence');
    assert.notEqual(v2Blocks.data[0]?.id, v1Block.id);
  } finally {
    await closeTestContext(context);
  }
});

test('RBAC blocks viewer from mutating assessment resources', async () => {
  const context = await createTestContext();
  try {
    const viewerToken = await login(context.app, 'viewer@acme.example', 'ViewerPass123!');

    const createAssessment = await context.app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: authHeaders(viewerToken),
      payload: {
        name: 'Unauthorized write',
        slug: 'unauthorized-write'
      }
    });

    assert.equal(createAssessment.statusCode, 403);
    const body = createAssessment.json() as { code: string; message: string };
    assert.equal(body.code, 'FORBIDDEN');
    assert.match(body.message, /insufficient role/i);
  } finally {
    await closeTestContext(context);
  }
});
