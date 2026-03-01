import Fastify, { type FastifyInstance } from 'fastify';

import { loadEnv, type EnvConfig } from './config/env.js';
import { createDatabaseClient, type DatabaseClient } from './lib/db.js';
import { toErrorPayload } from './lib/errors.js';
import { createJwtService } from './lib/jwt.js';
import { logger } from './lib/logger.js';
import { createOpenApiValidationProvider, type OpenApiValidationProvider } from './lib/openapi.js';
import { createAssessmentsRepository } from './modules/assessments/repository.js';
import { assessmentRoutes, registerAssessmentRoutes } from './modules/assessments/routes.js';
import { createAssessmentsService } from './modules/assessments/service.js';
import { createAnalyticsService } from './modules/analytics/service.js';
import { analyticsRoutes, registerAnalyticsRoutes } from './modules/analytics/routes.js';
import { authRoutes, registerAuthRoutes } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { createIntegrationsService } from './modules/integrations/service.js';
import { integrationRoutes, registerIntegrationRoutes } from './modules/integrations/routes.js';
import { publicRoutes, registerPublicRoutes } from './modules/public/routes.js';
import { createReportsService } from './modules/reports/service.js';
import { registerReportRoutes, reportRoutes } from './modules/reports/routes.js';
import { registerSessionRoutes, sessionRoutes } from './modules/sessions/routes.js';
import { createSessionsService } from './modules/sessions/service.js';
import { buildRouteManifest, type HttpRouteDef } from './types/http.js';

const allRouteDefs: HttpRouteDef[] = [
  ...authRoutes,
  ...assessmentRoutes,
  ...publicRoutes,
  ...sessionRoutes,
  ...reportRoutes,
  ...analyticsRoutes,
  ...integrationRoutes
];

export const routeManifest = buildRouteManifest(allRouteDefs);

export interface BuildServerOptions {
  env?: EnvConfig;
  db?: DatabaseClient;
  openApi?: OpenApiValidationProvider;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();
  const db = options.db ?? createDatabaseClient(env.databaseUrl);
  const shouldCloseDb = options.db === undefined;
  const openApi = options.openApi ?? (await createOpenApiValidationProvider());
  const jwtService = createJwtService(env);
  const assessmentsRepository = createAssessmentsRepository(db);
  const assessmentsService = createAssessmentsService({
    db,
    repository: assessmentsRepository
  });
  const sessionsService = createSessionsService({
    db,
    assessmentsRepository
  });
  const reportsService = createReportsService({
    db
  });
  const analyticsService = createAnalyticsService({
    db
  });
  const integrationsService = createIntegrationsService({
    db,
    webhookSecretEncryptionKey: env.webhookSecretEncryptionKey
  });
  const authService = createAuthService({
    db,
    jwtService,
    accessTokenTtlMinutes: env.accessTokenTtlMinutes,
    refreshTokenTtlDays: env.refreshTokenTtlDays
  });

  const app = Fastify({
    logger: false,
    trustProxy: true
  });

  app.setErrorHandler((error, request, reply) => {
    const payload = toErrorPayload(error, request.id);
    if (payload.statusCode >= 500) {
      logger.error('Unhandled request error', {
        requestId: request.id,
        path: request.url,
        method: request.method,
        error: String(error)
      });
    }
    reply.status(payload.statusCode).send(payload.body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: request.id
    });
  });

  app.get('/healthz', async () => ({
    ok: true,
    service: 'qassess-api',
    timestamp: new Date().toISOString()
  }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      reply.status(200).send({
        ok: true,
        service: 'qassess-api',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Readiness check failed', {
        error: String(error)
      });
      reply.status(503).send({
        ok: false,
        service: 'qassess-api',
        timestamp: new Date().toISOString()
      });
    }
  });

  await app.register(
    async (api) => {
      await registerAuthRoutes(api, { authService, jwtService, openApi });
      await registerAssessmentRoutes(api, {
        service: assessmentsService,
        jwtService,
        openApi
      });
      await registerPublicRoutes(api, {
        sessionsService,
        openApi,
        rateLimits: {
          bootstrapPerMinute: env.publicBootstrapRateLimitPerMinute,
          sessionStartPerMinute: env.publicSessionStartRateLimitPerMinute
        }
      });
      await registerSessionRoutes(api, {
        sessionsService,
        openApi,
        rateLimits: {
          sessionMutationPerMinute: env.publicSessionMutationRateLimitPerMinute
        }
      });
      await registerReportRoutes(api, {
        reportsService,
        jwtService,
        openApi
      });
      await registerAnalyticsRoutes(api, {
        analyticsService,
        jwtService,
        openApi
      });
      await registerIntegrationRoutes(api, {
        integrationsService,
        jwtService,
        openApi
      });
    },
    { prefix: '/v1' }
  );

  app.addHook('onClose', async () => {
    if (shouldCloseDb) {
      await db.close();
    }
  });

  return app;
}
