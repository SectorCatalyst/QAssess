import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../lib/errors.js';
import type { AccessTokenClaims, JwtService, UserRole } from '../lib/jwt.js';

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function parseBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing Authorization header');
  }

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid Authorization header format');
  }

  return token;
}

function claimsToContext(claims: AccessTokenClaims): AuthContext {
  return {
    tenantId: claims.tenantId,
    userId: claims.sub,
    role: claims.role
  };
}

export function requireAuth(jwtService: JwtService) {
  return async function authGuard(request: FastifyRequest): Promise<void> {
    const token = parseBearerToken(request);
    const claims = jwtService.verifyAccessToken(token);
    request.auth = claimsToContext(claims);
  };
}

export function requireRole(request: FastifyRequest, allowed: UserRole[]): void {
  const auth = request.auth;
  if (!auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  if (!allowed.includes(auth.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Insufficient role for this operation');
  }
}

