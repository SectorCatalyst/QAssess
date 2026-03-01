import type { HttpRouteDef } from '../../types/http.js';
import type { FastifyInstance } from 'fastify';

import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { createIpRateLimitGuard } from '../../middleware/rate-limit.js';
import type { SessionsService } from '../sessions/service.js';

export const publicRoutes: HttpRouteDef[] = [
  { method: 'GET', path: '/public/:slug/bootstrap', tag: 'Public Runtime', summary: 'Runtime bootstrap payload', auth: 'public' },
  { method: 'POST', path: '/public/:slug/sessions', tag: 'Public Runtime', summary: 'Start session', auth: 'public' }
];

interface PublicRouteDeps {
  sessionsService: SessionsService;
  openApi: OpenApiValidationProvider;
  rateLimits: {
    bootstrapPerMinute: number;
    sessionStartPerMinute: number;
  };
}

function parseUserAgent(header: string | string[] | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  return Array.isArray(header) ? header[0] : header;
}

function parseUtm(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      output[key] = entry;
    }
  }
  return output;
}

export async function registerPublicRoutes(app: FastifyInstance, deps: PublicRouteDeps): Promise<void> {
  const bootstrapRateLimitGuard = createIpRateLimitGuard({
    bucket: 'public_bootstrap',
    limitPerMinute: deps.rateLimits.bootstrapPerMinute
  });
  const sessionStartRateLimitGuard = createIpRateLimitGuard({
    bucket: 'public_session_start',
    limitPerMinute: deps.rateLimits.sessionStartPerMinute
  });

  app.get(
    '/public/:slug/bootstrap',
    {
      preHandler: [bootstrapRateLimitGuard],
      schema: deps.openApi.getRouteSchema('GET', '/public/{slug}/bootstrap')
    },
    async (request, reply) => {
      const params = request.params as { slug: string };
      const payload = await deps.sessionsService.getPublicBootstrap(params.slug);
      reply.status(200).send(payload);
    }
  );

  app.post(
    '/public/:slug/sessions',
    {
      preHandler: [sessionStartRateLimitGuard],
      schema: deps.openApi.getRouteSchema('POST', '/public/{slug}/sessions')
    },
    async (request, reply) => {
      const params = request.params as { slug: string };
      const body = request.body as { utm?: unknown } | undefined;

      const input: {
        slug: string;
        ipAddress: string;
        userAgent?: string;
        utm?: Record<string, string>;
      } = {
        slug: params.slug,
        ipAddress: request.ip
      };
      const userAgent = parseUserAgent(request.headers['user-agent']);
      if (userAgent) {
        input.userAgent = userAgent;
      }
      const utm = parseUtm(body?.utm);
      if (utm) {
        input.utm = utm;
      }

      const session = await deps.sessionsService.startPublicSession(input);
      reply.status(201).send(session);
    }
  );
}
