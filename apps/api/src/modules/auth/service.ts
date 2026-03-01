import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import type { JwtService, TokenSubject, UserRole } from '../../lib/jwt.js';
import { verifyPassword } from '../../lib/password.js';
import { recordAuditLog } from '../../lib/audit.js';

interface UserLoginRow {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  userStatus: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: Date | string;
}

interface UserProfileRow {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  email: string;
  role: UserRole;
  status: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: Date | string;
}

interface RefreshLookupRow extends UserLoginRow {
  jti: string;
}

export interface LoginInput {
  email: string;
  password: string;
  tenantSlug?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RefreshInput {
  refreshToken: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthUser {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  email: string;
  role: UserRole;
  status: string;
  createdAt: string;
  firstName?: string;
  lastName?: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

interface AuthServiceDeps {
  db: DatabaseClient;
  jwtService: JwtService;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeTenantSlug(tenantSlug?: string): string | null {
  if (!tenantSlug) {
    return null;
  }

  const normalized = tenantSlug.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function assertActiveStatus(userStatus: string, tenantStatus: string): void {
  if (userStatus !== 'active' || tenantStatus !== 'active') {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'User or tenant account is not active');
  }
}

function normalizeTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function toAuthUser(row: UserLoginRow | UserProfileRow): AuthUser {
  const user: AuthUser = {
    id: row.userId,
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    tenantName: row.tenantName,
    email: row.email,
    role: row.role,
    status: 'userStatus' in row ? row.userStatus : row.status,
    createdAt: normalizeTimestamp(row.createdAt)
  };

  if (row.firstName !== null) {
    user.firstName = row.firstName;
  }
  if (row.lastName !== null) {
    user.lastName = row.lastName;
  }

  return user;
}

function buildTokenSubject(row: UserLoginRow): TokenSubject {
  return {
    sub: row.userId,
    tenantId: row.tenantId,
    role: row.role
  };
}

function refreshExpiry(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function accessExpirySeconds(minutes: number): number {
  return minutes * 60;
}

export function createAuthService(deps: AuthServiceDeps) {
  const { db, jwtService, accessTokenTtlMinutes, refreshTokenTtlDays } = deps;

  return {
    async login(input: LoginInput): Promise<AuthResult> {
      const email = normalizeEmail(input.email);
      const tenantSlug = normalizeTenantSlug(input.tenantSlug);

      const query = await db.query<UserLoginRow>(
        `
          SELECT
            u.id AS "userId",
            u.tenant_id AS "tenantId",
            t.slug::text AS "tenantSlug",
            t.name AS "tenantName",
            t.status AS "tenantStatus",
            u.email::text AS email,
            u.password_hash AS "passwordHash",
            u.role::text AS role,
            u.status AS "userStatus",
            u.first_name AS "firstName",
            u.last_name AS "lastName",
            u.created_at AS "createdAt"
          FROM users u
          INNER JOIN tenants t ON t.id = u.tenant_id
          WHERE u.email = $1
            AND ($2::text IS NULL OR t.slug::text = $2::text)
          ORDER BY u.created_at ASC
          LIMIT 2
        `,
        [email, tenantSlug]
      );

      if (query.rows.length === 0) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      if (query.rows.length > 1 && tenantSlug === null) {
        throw new AppError(409, 'AMBIGUOUS_TENANT', 'Multiple tenants found for this email. Provide tenantSlug.');
      }

      const candidate = query.rows[0];
      if (!candidate) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      const valid = await verifyPassword(input.password, candidate.passwordHash);
      if (!valid) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      assertActiveStatus(candidate.userStatus, candidate.tenantStatus);

      const subject = buildTokenSubject(candidate);
      const jti = randomUUID();
      const accessToken = jwtService.issueAccessToken(subject);
      const refreshToken = jwtService.issueRefreshToken(subject, jti);

      await db.query(
        `
          INSERT INTO refresh_tokens (jti, user_id, tenant_id, issued_at, expires_at, meta)
          VALUES ($1, $2, $3, now(), $4, $5::jsonb)
        `,
        [
          jti,
          candidate.userId,
          candidate.tenantId,
          refreshExpiry(refreshTokenTtlDays),
          JSON.stringify({
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            source: 'login'
          })
        ]
      );

      await recordAuditLog(db, {
        tenantId: candidate.tenantId,
        actorUserId: candidate.userId,
        action: 'auth.login',
        targetType: 'user',
        targetId: candidate.userId,
        metadata: {
          ipAddress: input.ipAddress,
          userAgent: input.userAgent
        }
      });

      return {
        accessToken,
        refreshToken,
        expiresIn: accessExpirySeconds(accessTokenTtlMinutes),
        user: toAuthUser(candidate)
      };
    },

    async refresh(input: RefreshInput): Promise<AuthResult> {
      const claims = jwtService.verifyRefreshToken(input.refreshToken);

      const result = await db.withTransaction<AuthResult>(async (client) => {
        const lookup = await client.query<RefreshLookupRow>(
          `
            SELECT
              rt.jti,
              u.id AS "userId",
              u.tenant_id AS "tenantId",
              t.slug::text AS "tenantSlug",
              t.name AS "tenantName",
              t.status AS "tenantStatus",
              u.email::text AS email,
              u.password_hash AS "passwordHash",
              u.role::text AS role,
              u.status AS "userStatus",
              u.first_name AS "firstName",
              u.last_name AS "lastName",
              u.created_at AS "createdAt"
            FROM refresh_tokens rt
            INNER JOIN users u ON u.id = rt.user_id
            INNER JOIN tenants t ON t.id = rt.tenant_id
            WHERE rt.jti = $1
              AND rt.user_id = $2
              AND rt.tenant_id = $3
              AND rt.revoked_at IS NULL
              AND rt.expires_at > now()
            FOR UPDATE
          `,
          [claims.jti, claims.sub, claims.tenantId]
        );

        const current = lookup.rows[0];
        if (!current) {
          throw new AppError(401, 'INVALID_TOKEN', 'Refresh token has been revoked or expired');
        }

        assertActiveStatus(current.userStatus, current.tenantStatus);

        await client.query(
          `
            UPDATE refresh_tokens
            SET revoked_at = now(), revoke_reason = 'rotated'
            WHERE jti = $1
          `,
          [claims.jti]
        );

        const nextJti = randomUUID();
        const subject = buildTokenSubject(current);
        const accessToken = jwtService.issueAccessToken(subject);
        const refreshToken = jwtService.issueRefreshToken(subject, nextJti);

        await client.query(
          `
            INSERT INTO refresh_tokens (jti, user_id, tenant_id, issued_at, expires_at, meta)
            VALUES ($1, $2, $3, now(), $4, $5::jsonb)
          `,
          [
            nextJti,
            current.userId,
            current.tenantId,
            refreshExpiry(refreshTokenTtlDays),
            JSON.stringify({
              ipAddress: input.ipAddress,
              userAgent: input.userAgent,
              source: 'refresh'
            })
          ]
        );

        await recordAuditLog(client, {
          tenantId: current.tenantId,
          actorUserId: current.userId,
          action: 'auth.refresh',
          targetType: 'refresh_token',
          targetId: nextJti,
          metadata: {
            replacedJti: claims.jti,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent
          }
        });

        return {
          accessToken,
          refreshToken,
          expiresIn: accessExpirySeconds(accessTokenTtlMinutes),
          user: toAuthUser(current)
        };
      });

      return result;
    },

    async getCurrentUser(tenantId: string, userId: string): Promise<AuthUser> {
      const query = await db.query<UserProfileRow>(
        `
          SELECT
            u.id AS "userId",
            u.tenant_id AS "tenantId",
            t.slug::text AS "tenantSlug",
            t.name AS "tenantName",
            u.email::text AS email,
            u.role::text AS role,
            u.status AS status,
            u.first_name AS "firstName",
            u.last_name AS "lastName",
            u.created_at AS "createdAt"
          FROM users u
          INNER JOIN tenants t ON t.id = u.tenant_id
          WHERE u.id = $1
            AND u.tenant_id = $2
            AND u.status = 'active'
            AND t.status = 'active'
          LIMIT 1
        `,
        [userId, tenantId]
      );

      const row = query.rows[0];
      if (!row) {
        throw new AppError(404, 'USER_NOT_FOUND', 'Authenticated user not found');
      }

      return toAuthUser(row);
    }
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
