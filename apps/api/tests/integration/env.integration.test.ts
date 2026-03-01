import assert from 'node:assert/strict';
import test from 'node:test';

import { loadEnv } from '../../src/config/env.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('loadEnv enforces strong JWT secret policy when strict validation is enabled', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      PORT: '4000',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/qassess',
      JWT_ACCESS_SECRET: 'short-secret',
      JWT_REFRESH_SECRET: 'another-short-secret',
      STRICT_SECRET_VALIDATION: 'true',
      ACCESS_TOKEN_TTL_MINUTES: '15',
      REFRESH_TOKEN_TTL_DAYS: '30',
      PUBLIC_BOOTSTRAP_RATE_LIMIT_PER_MINUTE: '120',
      PUBLIC_SESSION_START_RATE_LIMIT_PER_MINUTE: '60',
      PUBLIC_SESSION_MUTATION_RATE_LIMIT_PER_MINUTE: '180'
    },
    () => {
      assert.throws(() => loadEnv(), /at least 32 characters/i);
    }
  );
});

test('loadEnv accepts strong JWT secrets when strict validation is enabled', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      PORT: '4000',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/qassess',
      JWT_ACCESS_SECRET: '0123456789abcdef0123456789abcdef',
      JWT_REFRESH_SECRET: 'fedcba9876543210fedcba9876543210',
      STRICT_SECRET_VALIDATION: 'true',
      ACCESS_TOKEN_TTL_MINUTES: '15',
      REFRESH_TOKEN_TTL_DAYS: '30',
      PUBLIC_BOOTSTRAP_RATE_LIMIT_PER_MINUTE: '120',
      PUBLIC_SESSION_START_RATE_LIMIT_PER_MINUTE: '60',
      PUBLIC_SESSION_MUTATION_RATE_LIMIT_PER_MINUTE: '180'
    },
    () => {
      const env = loadEnv();
      assert.equal(env.strictSecretValidation, true);
      assert.equal(env.publicBootstrapRateLimitPerMinute, 120);
      assert.equal(env.publicSessionStartRateLimitPerMinute, 60);
      assert.equal(env.publicSessionMutationRateLimitPerMinute, 180);
    }
  );
});

test('loadEnv enforces strong webhook encryption key when explicitly provided in strict mode', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      PORT: '4000',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/qassess',
      JWT_ACCESS_SECRET: '0123456789abcdef0123456789abcdef',
      JWT_REFRESH_SECRET: 'fedcba9876543210fedcba9876543210',
      WEBHOOK_SECRET_ENCRYPTION_KEY: 'weak-key',
      STRICT_SECRET_VALIDATION: 'true',
      ACCESS_TOKEN_TTL_MINUTES: '15',
      REFRESH_TOKEN_TTL_DAYS: '30',
      PUBLIC_BOOTSTRAP_RATE_LIMIT_PER_MINUTE: '120',
      PUBLIC_SESSION_START_RATE_LIMIT_PER_MINUTE: '60',
      PUBLIC_SESSION_MUTATION_RATE_LIMIT_PER_MINUTE: '180'
    },
    () => {
      assert.throws(() => loadEnv(), /WEBHOOK_SECRET_ENCRYPTION_KEY/i);
    }
  );
});
