import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { newDb } from 'pg-mem';
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

async function seedAuthSchema(db: DatabaseClient): Promise<void> {
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query('CREATE UNIQUE INDEX users_tenant_email_unique ON users (tenant_id, email)');

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

  const passwordHash = await hashPassword('ChangeMe123!');

  await db.query(
    `
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        ('tenant-acme', 'Acme Advisory', 'acme', 'active'),
        ('tenant-beta', 'Beta Advisory', 'beta', 'active')
    `
  );

  await db.query(
    `
      INSERT INTO users (id, tenant_id, email, password_hash, role, status, first_name, last_name)
      VALUES
        ('user-acme-owner', 'tenant-acme', 'owner@acme.example', $1, 'owner', 'active', 'Acme', 'Owner'),
        ('user-beta-owner', 'tenant-beta', 'owner@acme.example', $1, 'owner', 'active', 'Beta', 'Owner')
    `,
    [passwordHash]
  );
}

async function createTestContext(): Promise<TestContext> {
  const db = createInMemoryDatabaseClient();
  await seedAuthSchema(db);

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

test('auth login validates request body via OpenAPI schema', async () => {
  const context = await createTestContext();
  try {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@acme.example' }
    });

    assert.equal(response.statusCode, 400);
    const body = response.json() as { code: string; message: string; requestId: string };
    assert.equal(body.code, 'FST_ERR_VALIDATION');
    assert.match(body.message, /password/i);
    assert.ok(body.requestId.length > 0);
  } finally {
    await closeTestContext(context);
  }
});

test('auth login requires tenantSlug when email exists in multiple tenants', async () => {
  const context = await createTestContext();
  try {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'owner@acme.example',
        password: 'ChangeMe123!'
      }
    });

    assert.equal(response.statusCode, 409);
    const body = response.json() as { code: string };
    assert.equal(body.code, 'AMBIGUOUS_TENANT');
  } finally {
    await closeTestContext(context);
  }
});

test('auth login and me endpoints succeed with tenant-scoped token', async () => {
  const context = await createTestContext();
  try {
    const login = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'owner@acme.example',
        password: 'ChangeMe123!',
        tenantSlug: 'acme'
      }
    });

    assert.equal(login.statusCode, 200);
    const auth = login.json() as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { tenantId: string; tenantSlug: string; email: string };
    };
    assert.ok(auth.accessToken.length > 30);
    assert.ok(auth.refreshToken.length > 30);
    assert.equal(auth.expiresIn, 900);
    assert.equal(auth.user.tenantId, 'tenant-acme');
    assert.equal(auth.user.tenantSlug, 'acme');
    assert.equal(auth.user.email, 'owner@acme.example');

    const me = await context.app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: {
        authorization: `Bearer ${auth.accessToken}`
      }
    });

    assert.equal(me.statusCode, 200);
    const meBody = me.json() as { id: string; tenantId: string; email: string; role: string };
    assert.equal(meBody.id, 'user-acme-owner');
    assert.equal(meBody.tenantId, 'tenant-acme');
    assert.equal(meBody.email, 'owner@acme.example');
    assert.equal(meBody.role, 'owner');
  } finally {
    await closeTestContext(context);
  }
});

test('refresh token rotation invalidates old token', async () => {
  const context = await createTestContext();
  try {
    const login = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'owner@acme.example',
        password: 'ChangeMe123!',
        tenantSlug: 'acme'
      }
    });
    assert.equal(login.statusCode, 200);
    const loginBody = login.json() as { refreshToken: string };

    const firstRefresh = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken }
    });
    assert.equal(firstRefresh.statusCode, 200);
    const refreshBody = firstRefresh.json() as { refreshToken: string };
    assert.notEqual(refreshBody.refreshToken, loginBody.refreshToken);

    const replay = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken }
    });
    assert.equal(replay.statusCode, 401);
    const replayBody = replay.json() as { code: string };
    assert.equal(replayBody.code, 'INVALID_TOKEN');
  } finally {
    await closeTestContext(context);
  }
});
