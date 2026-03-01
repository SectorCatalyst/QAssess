import type { FastifyInstance } from 'fastify';

import { AppError } from '../../lib/errors.js';
import type { JwtService } from '../../lib/jwt.js';
import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { HttpRouteDef } from '../../types/http.js';
import type { ReportsService } from './service.js';

export const reportRoutes: HttpRouteDef[] = [
  { method: 'GET', path: '/versions/:versionId/report-template', tag: 'Reports', summary: 'Get report template', auth: 'bearer' },
  { method: 'PUT', path: '/versions/:versionId/report-template', tag: 'Reports', summary: 'Upsert report template', auth: 'bearer' },
  { method: 'POST', path: '/report-templates/:templateId/sections', tag: 'Reports', summary: 'Create report section', auth: 'bearer' },
  { method: 'PATCH', path: '/report-sections/:sectionId', tag: 'Reports', summary: 'Update report section', auth: 'bearer' },
  { method: 'DELETE', path: '/report-sections/:sectionId', tag: 'Reports', summary: 'Delete report section', auth: 'bearer' }
];

interface ReportRouteDeps {
  reportsService: ReportsService;
  jwtService: JwtService;
  openApi: OpenApiValidationProvider;
}

function getAuth(request: { auth?: { tenantId: string; userId: string; role: 'owner' | 'editor' | 'analyst' | 'viewer' } }) {
  if (!request.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return request.auth;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export async function registerReportRoutes(app: FastifyInstance, deps: ReportRouteDeps): Promise<void> {
  const authGuard = requireAuth(deps.jwtService);

  app.get(
    '/versions/:versionId/report-template',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/versions/{versionId}/report-template')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { versionId: string };
      const template = await deps.reportsService.getReportTemplate(auth.tenantId, params.versionId);
      reply.status(200).send(template);
    }
  );

  app.put(
    '/versions/:versionId/report-template',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PUT', '/versions/{versionId}/report-template')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const body = request.body as {
        title: string;
        headerContent?: unknown;
        footerContent?: unknown;
      };

      const input: {
        tenantId: string;
        versionId: string;
        actorUserId: string;
        title: string;
        headerContent?: Record<string, unknown>;
        footerContent?: Record<string, unknown>;
      } = {
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        title: body.title
      };
      const headerContent = asObject(body.headerContent);
      if (headerContent) {
        input.headerContent = headerContent;
      }
      const footerContent = asObject(body.footerContent);
      if (footerContent) {
        input.footerContent = footerContent;
      }

      const template = await deps.reportsService.upsertReportTemplate(input);
      reply.status(200).send(template);
    }
  );

  app.post(
    '/report-templates/:templateId/sections',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/report-templates/{templateId}/sections')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { templateId: string };
      const body = request.body as {
        sectionKey: string;
        title: string;
        bodyTemplate: string;
        displayCondition?: unknown;
        position: number;
      };

      const input: {
        tenantId: string;
        templateId: string;
        actorUserId: string;
        sectionKey: string;
        title: string;
        bodyTemplate: string;
        displayCondition?: Record<string, unknown>;
        position: number;
      } = {
        tenantId: auth.tenantId,
        templateId: params.templateId,
        actorUserId: auth.userId,
        sectionKey: body.sectionKey,
        title: body.title,
        bodyTemplate: body.bodyTemplate,
        position: body.position
      };
      const displayCondition = asObject(body.displayCondition);
      if (displayCondition) {
        input.displayCondition = displayCondition;
      }

      const section = await deps.reportsService.createReportSection(input);
      reply.status(201).send(section);
    }
  );

  app.patch(
    '/report-sections/:sectionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/report-sections/{sectionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { sectionId: string };
      const body = request.body as Partial<{
        title: string;
        bodyTemplate: string;
        displayCondition: unknown;
        position: number;
      }>;

      const patch: Partial<{
        title: string;
        bodyTemplate: string;
        displayCondition: Record<string, unknown>;
        position: number;
      }> = {};
      if (typeof body.title === 'string') {
        patch.title = body.title;
      }
      if (typeof body.bodyTemplate === 'string') {
        patch.bodyTemplate = body.bodyTemplate;
      }
      const displayCondition = asObject(body.displayCondition);
      if (displayCondition) {
        patch.displayCondition = displayCondition;
      }
      if (typeof body.position === 'number') {
        patch.position = body.position;
      }

      const section = await deps.reportsService.updateReportSection({
        tenantId: auth.tenantId,
        sectionId: params.sectionId,
        actorUserId: auth.userId,
        patch
      });
      reply.status(200).send(section);
    }
  );

  app.delete(
    '/report-sections/:sectionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('DELETE', '/report-sections/{sectionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { sectionId: string };
      await deps.reportsService.deleteReportSection({
        tenantId: auth.tenantId,
        sectionId: params.sectionId,
        actorUserId: auth.userId
      });
      reply.status(204).send();
    }
  );
}
