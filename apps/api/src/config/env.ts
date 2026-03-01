export interface EnvConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  webhookSecretEncryptionKey: string;
  strictSecretValidation: boolean;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  publicBootstrapRateLimitPerMinute: number;
  publicSessionStartRateLimitPerMinute: number;
  publicSessionMutationRateLimitPerMinute: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }

  return parsed;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false)`);
}

function validateSecretStrength(name: string, value: string): void {
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters when strict secret validation is enabled`);
  }

  const normalized = value.toLowerCase();
  if (
    normalized.includes('replace-with-strong') ||
    normalized.includes('changeme') ||
    normalized.includes('example') ||
    normalized.includes('password')
  ) {
    throw new Error(`${name} appears to be a placeholder and must be replaced with a strong secret`);
  }
}

export function loadEnv(): EnvConfig {
  const port = parseNumber('PORT', 4000, 1, 65535);
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const databaseUrl = required('DATABASE_URL');
  const jwtAccessSecret = required('JWT_ACCESS_SECRET');
  const jwtRefreshSecret = required('JWT_REFRESH_SECRET');
  const webhookSecretEncryptionKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? jwtRefreshSecret;
  const strictSecretValidation = parseBoolean('STRICT_SECRET_VALIDATION', nodeEnv === 'production');

  if (strictSecretValidation) {
    validateSecretStrength('JWT_ACCESS_SECRET', jwtAccessSecret);
    validateSecretStrength('JWT_REFRESH_SECRET', jwtRefreshSecret);
    validateSecretStrength('WEBHOOK_SECRET_ENCRYPTION_KEY', webhookSecretEncryptionKey);
    if (jwtAccessSecret === jwtRefreshSecret) {
      throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values');
    }
  }

  return {
    nodeEnv,
    port,
    databaseUrl,
    jwtAccessSecret,
    jwtRefreshSecret,
    webhookSecretEncryptionKey,
    strictSecretValidation,
    accessTokenTtlMinutes: parseNumber('ACCESS_TOKEN_TTL_MINUTES', 15, 1, 240),
    refreshTokenTtlDays: parseNumber('REFRESH_TOKEN_TTL_DAYS', 30, 1, 180),
    publicBootstrapRateLimitPerMinute: parseNumber('PUBLIC_BOOTSTRAP_RATE_LIMIT_PER_MINUTE', 120, 1, 5000),
    publicSessionStartRateLimitPerMinute: parseNumber('PUBLIC_SESSION_START_RATE_LIMIT_PER_MINUTE', 60, 1, 5000),
    publicSessionMutationRateLimitPerMinute: parseNumber('PUBLIC_SESSION_MUTATION_RATE_LIMIT_PER_MINUTE', 180, 1, 5000)
  };
}
