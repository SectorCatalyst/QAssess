import type { FastifyInstance } from 'fastify';

import { AppError } from '../../lib/errors.js';
import type { JwtService } from '../../lib/jwt.js';
import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { requireAuth } from '../../middleware/auth.js';
import type { HttpRouteDef } from '../../types/http.js';
import type { AnalyticsService } from './service.js';

export const analyticsRoutes: HttpRouteDef[] = [
  { method: 'GET', path: '/analytics/assessments/:assessmentId/summary', tag: 'Analytics', summary: 'Get funnel summary', auth: 'bearer' },
  { method: 'GET', path: '/analytics/assessments/:assessmentId/dropoff', tag: 'Analytics', summary: 'Get dropoff metrics', auth: 'bearer' }
];

interface AnalyticsRouteDeps {
  analyticsService: AnalyticsService;
  jwtService: JwtService;
  openApi: OpenApiValidationProvider;
}

function getAuth(request: { auth?: { tenantId: string } }) {
  if (!request.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return request.auth;
}

export async function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsRouteDeps): Promise<void> {
  const authGuard = requireAuth(deps.jwtService);

  app.get(
    '/analytics/assessments/:assessmentId/summary',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/analytics/assessments/{assessmentId}/summary')
    },
    async (request, reply) => {
      const auth = getAuth(request);
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

      const summary = await deps.analyticsService.getAssessmentSummary(input);

      reply.status(200).send(summary);
    }
  );

  app.get(
    '/analytics/assessments/:assessmentId/dropoff',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/analytics/assessments/{assessmentId}/dropoff')
    },
    async (request, reply) => {
      const auth = getAuth(request);
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

      const metrics = await deps.analyticsService.getAssessmentDropoff(input);

      reply.status(200).send({ data: metrics });
    }
  );
}
