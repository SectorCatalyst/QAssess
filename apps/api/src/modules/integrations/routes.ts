import type { FastifyInstance } from 'fastify';

import { AppError } from '../../lib/errors.js';
import type { JwtService } from '../../lib/jwt.js';
import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { HttpRouteDef } from '../../types/http.js';
import type { IntegrationsService } from './service.js';

export const integrationRoutes: HttpRouteDef[] = [
  { method: 'GET', path: '/integrations/webhooks', tag: 'Integrations', summary: 'List webhook endpoints', auth: 'bearer' },
  { method: 'POST', path: '/integrations/webhooks', tag: 'Integrations', summary: 'Create webhook endpoint', auth: 'bearer' },
  { method: 'PATCH', path: '/integrations/webhooks/:endpointId', tag: 'Integrations', summary: 'Update webhook endpoint', auth: 'bearer' },
  { method: 'DELETE', path: '/integrations/webhooks/:endpointId', tag: 'Integrations', summary: 'Delete webhook endpoint', auth: 'bearer' },
  { method: 'GET', path: '/assessments/:assessmentId/leads/export', tag: 'Integrations', summary: 'Export leads CSV', auth: 'bearer' }
];

interface IntegrationsRouteDeps {
  integrationsService: IntegrationsService;
  jwtService: JwtService;
  openApi: OpenApiValidationProvider;
}

function getAuth(request: { auth?: { tenantId: string; userId: string; role: 'owner' | 'editor' | 'analyst' | 'viewer' } }) {
  if (!request.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return request.auth;
}

export async function registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationsRouteDeps): Promise<void> {
  const authGuard = requireAuth(deps.jwtService);

  app.get(
    '/integrations/webhooks',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/integrations/webhooks')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor', 'analyst']);
      const endpoints = await deps.integrationsService.listWebhookEndpoints(auth.tenantId);
      reply.status(200).send({ data: endpoints });
    }
  );

  app.post(
    '/integrations/webhooks',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/integrations/webhooks')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const body = request.body as {
        name: string;
        targetUrl: string;
        secret: string;
        subscribedEvents: string[];
      };

      const endpoint = await deps.integrationsService.createWebhookEndpoint({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        name: body.name,
        targetUrl: body.targetUrl,
        secret: body.secret,
        subscribedEvents: body.subscribedEvents
      });

      reply.status(201).send(endpoint);
    }
  );

  app.patch(
    '/integrations/webhooks/:endpointId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/integrations/webhooks/{endpointId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { endpointId: string };
      const body = request.body as Partial<{
        name: string;
        targetUrl: string;
        secret: string;
        subscribedEvents: string[];
        isActive: boolean;
      }>;

      const patch: Partial<{
        name: string;
        targetUrl: string;
        secret: string;
        subscribedEvents: string[];
        isActive: boolean;
      }> = {};
      if (typeof body.name === 'string') {
        patch.name = body.name;
      }
      if (typeof body.targetUrl === 'string') {
        patch.targetUrl = body.targetUrl;
      }
      if (typeof body.secret === 'string') {
        patch.secret = body.secret;
      }
      if (Array.isArray(body.subscribedEvents)) {
        patch.subscribedEvents = body.subscribedEvents.filter((entry): entry is string => typeof entry === 'string');
      }
      if (typeof body.isActive === 'boolean') {
        patch.isActive = body.isActive;
      }

      const endpoint = await deps.integrationsService.updateWebhookEndpoint({
        tenantId: auth.tenantId,
        endpointId: params.endpointId,
        actorUserId: auth.userId,
        patch
      });

      reply.status(200).send(endpoint);
    }
  );

  app.delete(
    '/integrations/webhooks/:endpointId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('DELETE', '/integrations/webhooks/{endpointId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { endpointId: string };
      await deps.integrationsService.deleteWebhookEndpoint({
        tenantId: auth.tenantId,
        endpointId: params.endpointId,
        actorUserId: auth.userId
      });

      reply.status(204).send();
    }
  );

  app.get(
    '/assessments/:assessmentId/leads/export',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/assessments/{assessmentId}/leads/export')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor', 'analyst']);

      const params = request.params as { assessmentId: string };
      const query = request.query as { dateFrom?: string; dateTo?: string };

      const input: {
        tenantId: string;
        assessmentId: string;
        dateFrom?: string;
        dateTo?: string;
      } = {
        tenantId: auth.tenantId,
        assessmentId: params.assessmentId
      };
      if (typeof query.dateFrom === 'string') {
        input.dateFrom = query.dateFrom;
      }
      if (typeof query.dateTo === 'string') {
        input.dateTo = query.dateTo;
      }

      const csv = await deps.integrationsService.exportLeadsCsv(input);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.status(200).send(csv);
    }
  );
}
