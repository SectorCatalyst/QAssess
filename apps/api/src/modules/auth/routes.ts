import type { HttpRouteDef } from '../../types/http.js';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../lib/errors.js';
import type { JwtService } from '../../lib/jwt.js';
import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { requireAuth } from '../../middleware/auth.js';
import type { AuthService } from './service.js';

export const authRoutes: HttpRouteDef[] = [
  { method: 'POST', path: '/auth/login', tag: 'Auth', summary: 'Admin login', auth: 'public' },
  { method: 'POST', path: '/auth/refresh', tag: 'Auth', summary: 'Refresh token', auth: 'public' },
  { method: 'GET', path: '/users/me', tag: 'Auth', summary: 'Current user', auth: 'bearer' }
];

interface LoginBody {
  email: string;
  password: string;
  tenantSlug?: string;
}

interface RefreshBody {
  refreshToken: string;
}

interface AuthRouteDeps {
  authService: AuthService;
  jwtService: JwtService;
  openApi: OpenApiValidationProvider;
}

function parseUserAgent(header: string | string[] | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  return Array.isArray(header) ? header[0] : header;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const authGuard = requireAuth(deps.jwtService);

  app.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      schema: deps.openApi.getRouteSchema('POST', '/auth/login')
    },
    async (request, reply) => {
    const { email, password, tenantSlug } = request.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.trim() === '' || password === '') {
      throw new AppError(422, 'VALIDATION_ERROR', 'email and password are required');
    }

    const loginInput: {
      email: string;
      password: string;
      tenantSlug?: string;
      ipAddress: string;
      userAgent?: string;
    } = {
      email,
      password,
      ipAddress: request.ip
    };
    const userAgent = parseUserAgent(request.headers['user-agent']);
    if (userAgent) {
      loginInput.userAgent = userAgent;
    }
    if (typeof tenantSlug === 'string' && tenantSlug.trim() !== '') {
      loginInput.tenantSlug = tenantSlug;
    }

    const result = await deps.authService.login(loginInput);

    reply.status(200).send(result);
    }
  );

  app.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    {
      schema: deps.openApi.getRouteSchema('POST', '/auth/refresh')
    },
    async (request, reply) => {
    const { refreshToken } = request.body ?? {};
    if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
      throw new AppError(422, 'VALIDATION_ERROR', 'refreshToken is required');
    }

    const refreshInput: {
      refreshToken: string;
      ipAddress: string;
      userAgent?: string;
    } = {
      refreshToken,
      ipAddress: request.ip
    };
    const userAgent = parseUserAgent(request.headers['user-agent']);
    if (userAgent) {
      refreshInput.userAgent = userAgent;
    }

    const result = await deps.authService.refresh(refreshInput);

    reply.status(200).send(result);
    }
  );

  app.get(
    '/users/me',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/users/me')
    },
    async (request, reply) => {
      if (!request.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      const user = await deps.authService.getCurrentUser(request.auth.tenantId, request.auth.userId);
      reply.status(200).send(user);
    }
  );
}
