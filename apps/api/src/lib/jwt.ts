import jwt from 'jsonwebtoken';

import type { EnvConfig } from '../config/env.js';
import { AppError } from './errors.js';

export type UserRole = 'owner' | 'editor' | 'analyst' | 'viewer';

export interface TokenSubject {
  sub: string;
  tenantId: string;
  role: UserRole;
}

interface BaseClaims extends TokenSubject {
  type: 'access' | 'refresh';
}

export interface AccessTokenClaims extends BaseClaims {
  type: 'access';
}

export interface RefreshTokenClaims extends BaseClaims {
  type: 'refresh';
  jti: string;
}

export interface JwtService {
  issueAccessToken(subject: TokenSubject): string;
  issueRefreshToken(subject: TokenSubject, jti: string): string;
  verifyAccessToken(token: string): AccessTokenClaims;
  verifyRefreshToken(token: string): RefreshTokenClaims;
}

function asObjectPayload(decoded: string | jwt.JwtPayload): jwt.JwtPayload {
  if (typeof decoded === 'string') {
    throw new AppError(401, 'INVALID_TOKEN', 'Token payload is malformed');
  }
  return decoded;
}

function validateAccessClaims(payload: jwt.JwtPayload): AccessTokenClaims {
  if (payload.type !== 'access' || typeof payload.sub !== 'string' || typeof payload.tenantId !== 'string' || typeof payload.role !== 'string') {
    throw new AppError(401, 'INVALID_TOKEN', 'Access token payload is malformed');
  }

  return {
    type: 'access',
    sub: payload.sub,
    tenantId: payload.tenantId,
    role: payload.role as UserRole
  };
}

function validateRefreshClaims(payload: jwt.JwtPayload): RefreshTokenClaims {
  if (
    payload.type !== 'refresh' ||
    typeof payload.sub !== 'string' ||
    typeof payload.tenantId !== 'string' ||
    typeof payload.role !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    throw new AppError(401, 'INVALID_TOKEN', 'Refresh token payload is malformed');
  }

  return {
    type: 'refresh',
    sub: payload.sub,
    tenantId: payload.tenantId,
    role: payload.role as UserRole,
    jti: payload.jti
  };
}

export function createJwtService(env: EnvConfig): JwtService {
  const accessExpiresInSeconds = env.accessTokenTtlMinutes * 60;
  const refreshExpiresInSeconds = env.refreshTokenTtlDays * 24 * 60 * 60;

  return {
    issueAccessToken(subject: TokenSubject): string {
      return jwt.sign(
        {
          ...subject,
          type: 'access'
        },
        env.jwtAccessSecret,
        {
          expiresIn: accessExpiresInSeconds,
          audience: 'qassess-api',
          issuer: 'qassess-auth'
        }
      );
    },

    issueRefreshToken(subject: TokenSubject, jti: string): string {
      return jwt.sign(
        {
          ...subject,
          type: 'refresh',
          jti
        },
        env.jwtRefreshSecret,
        {
          expiresIn: refreshExpiresInSeconds,
          audience: 'qassess-api',
          issuer: 'qassess-auth'
        }
      );
    },

    verifyAccessToken(token: string): AccessTokenClaims {
      try {
        const decoded = jwt.verify(token, env.jwtAccessSecret, {
          audience: 'qassess-api',
          issuer: 'qassess-auth'
        });
        return validateAccessClaims(asObjectPayload(decoded));
      } catch {
        throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid or expired');
      }
    },

    verifyRefreshToken(token: string): RefreshTokenClaims {
      try {
        const decoded = jwt.verify(token, env.jwtRefreshSecret, {
          audience: 'qassess-api',
          issuer: 'qassess-auth'
        });
        return validateRefreshClaims(asObjectPayload(decoded));
      } catch {
        throw new AppError(401, 'INVALID_TOKEN', 'Refresh token is invalid or expired');
      }
    }
  };
}
