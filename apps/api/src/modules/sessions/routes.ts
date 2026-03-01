import type { HttpRouteDef } from '../../types/http.js';
import type { FastifyInstance } from 'fastify';

import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { createIpRateLimitGuard } from '../../middleware/rate-limit.js';
import type { SessionsService } from './service.js';

export const sessionRoutes: HttpRouteDef[] = [
  { method: 'POST', path: '/sessions/:sessionId/lead', tag: 'Sessions', summary: 'Upsert lead', auth: 'public' },
  { method: 'PUT', path: '/sessions/:sessionId/responses', tag: 'Sessions', summary: 'Upsert response', auth: 'public' },
  { method: 'POST', path: '/sessions/:sessionId/complete', tag: 'Sessions', summary: 'Complete and score', auth: 'public' },
  { method: 'GET', path: '/sessions/:sessionId/result', tag: 'Sessions', summary: 'Get final result', auth: 'public' },
  { method: 'POST', path: '/sessions/:sessionId/pdf', tag: 'PDF', summary: 'Queue PDF generation', auth: 'public' },
  { method: 'GET', path: '/pdf-jobs/:jobId', tag: 'PDF', summary: 'Get PDF status', auth: 'public' }
];

interface SessionRouteDeps {
  sessionsService: SessionsService;
  openApi: OpenApiValidationProvider;
  rateLimits: {
    sessionMutationPerMinute: number;
  };
}

export async function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): Promise<void> {
  const sessionMutationRateLimitGuard = createIpRateLimitGuard({
    bucket: 'public_session_mutation',
    limitPerMinute: deps.rateLimits.sessionMutationPerMinute
  });

  app.post(
    '/sessions/:sessionId/lead',
    {
      preHandler: [sessionMutationRateLimitGuard],
      schema: deps.openApi.getRouteSchema('POST', '/sessions/{sessionId}/lead')
    },
    async (request, reply) => {
      const params = request.params as { sessionId: string };
      const body = request.body as {
        email: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
        company?: string;
        customFields?: Record<string, unknown>;
        consent: boolean;
      };

      const input: {
        sessionId: string;
        email: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
        company?: string;
        customFields?: Record<string, unknown>;
        consent: boolean;
      } = {
        sessionId: params.sessionId,
        email: body.email,
        consent: body.consent
      };
      if (typeof body.firstName === 'string') {
        input.firstName = body.firstName;
      }
      if (typeof body.lastName === 'string') {
        input.lastName = body.lastName;
      }
      if (typeof body.phone === 'string') {
        input.phone = body.phone;
      }
      if (typeof body.company === 'string') {
        input.company = body.company;
      }
      if (body.customFields && typeof body.customFields === 'object' && !Array.isArray(body.customFields)) {
        input.customFields = body.customFields;
      }

      const lead = await deps.sessionsService.upsertLead(input);
      reply.status(200).send(lead);
    }
  );

  app.put(
    '/sessions/:sessionId/responses',
    {
      preHandler: [sessionMutationRateLimitGuard],
      schema: deps.openApi.getRouteSchema('PUT', '/sessions/{sessionId}/responses')
    },
    async (request, reply) => {
      const params = request.params as { sessionId: string };
      const body = request.body as {
        questionId: string;
        answer: string | number | string[] | Record<string, unknown>;
      };

      const response = await deps.sessionsService.upsertResponse({
        sessionId: params.sessionId,
        questionId: body.questionId,
        answer: body.answer
      });
      reply.status(200).send(response);
    }
  );

  app.post(
    '/sessions/:sessionId/complete',
    {
      preHandler: [sessionMutationRateLimitGuard],
      schema: deps.openApi.getRouteSchema('POST', '/sessions/{sessionId}/complete')
    },
    async (request, reply) => {
      const params = request.params as { sessionId: string };
      const result = await deps.sessionsService.completeSession(params.sessionId);
      reply.status(200).send(result);
    }
  );

  app.get(
    '/sessions/:sessionId/result',
    {
      preHandler: [sessionMutationRateLimitGuard],
      schema: deps.openApi.getRouteSchema('GET', '/sessions/{sessionId}/result')
    },
    async (request, reply) => {
      const params = request.params as { sessionId: string };
      const result = await deps.sessionsService.getSessionResult(params.sessionId);
      reply.status(200).send(result);
    }
  );

  app.post(
    '/sessions/:sessionId/pdf',
    {
      preHandler: [sessionMutationRateLimitGuard],
      schema: deps.openApi.getRouteSchema('POST', '/sessions/{sessionId}/pdf')
    },
    async (request, reply) => {
      const params = request.params as { sessionId: string };
      const body = request.body as { emailTo?: string } | undefined;

      const input: {
        sessionId: string;
        emailTo?: string;
      } = {
        sessionId: params.sessionId
      };
      if (typeof body?.emailTo === 'string') {
        input.emailTo = body.emailTo;
      }

      const job = await deps.sessionsService.queuePdfJob(input);
      reply.status(202).send(job);
    }
  );

  app.get(
    '/pdf-jobs/:jobId',
    {
      preHandler: [sessionMutationRateLimitGuard],
      schema: deps.openApi.getRouteSchema('GET', '/pdf-jobs/{jobId}')
    },
    async (request, reply) => {
      const params = request.params as { jobId: string };
      const job = await deps.sessionsService.getPdfJob(params.jobId);
      reply.status(200).send(job);
    }
  );
}
