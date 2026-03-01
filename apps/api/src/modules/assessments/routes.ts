import type { FastifyInstance } from 'fastify';

import { AppError } from '../../lib/errors.js';
import type { JwtService } from '../../lib/jwt.js';
import type { OpenApiValidationProvider } from '../../lib/openapi.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { HttpRouteDef } from '../../types/http.js';
import type { AssessmentsService } from './service.js';

export const assessmentRoutes: HttpRouteDef[] = [
  { method: 'GET', path: '/assessments', tag: 'Assessments', summary: 'List assessments', auth: 'bearer' },
  { method: 'POST', path: '/assessments', tag: 'Assessments', summary: 'Create assessment', auth: 'bearer' },
  { method: 'GET', path: '/assessments/:assessmentId', tag: 'Assessments', summary: 'Get assessment', auth: 'bearer' },
  { method: 'PATCH', path: '/assessments/:assessmentId', tag: 'Assessments', summary: 'Update assessment', auth: 'bearer' },
  { method: 'GET', path: '/assessments/:assessmentId/versions', tag: 'Assessments', summary: 'List versions', auth: 'bearer' },
  { method: 'POST', path: '/assessments/:assessmentId/versions', tag: 'Assessments', summary: 'Create version', auth: 'bearer' },
  { method: 'GET', path: '/versions/:versionId', tag: 'Assessments', summary: 'Get version', auth: 'bearer' },
  { method: 'PATCH', path: '/versions/:versionId', tag: 'Assessments', summary: 'Update version', auth: 'bearer' },
  { method: 'POST', path: '/versions/:versionId/publish', tag: 'Assessments', summary: 'Publish version', auth: 'bearer' },
  { method: 'GET', path: '/versions/:versionId/landing', tag: 'Landing Builder', summary: 'Get landing page', auth: 'bearer' },
  { method: 'PUT', path: '/versions/:versionId/landing', tag: 'Landing Builder', summary: 'Replace landing page metadata', auth: 'bearer' },
  { method: 'GET', path: '/versions/:versionId/landing/blocks', tag: 'Landing Builder', summary: 'List landing blocks', auth: 'bearer' },
  { method: 'POST', path: '/versions/:versionId/landing/blocks', tag: 'Landing Builder', summary: 'Add landing block', auth: 'bearer' },
  { method: 'PATCH', path: '/landing/blocks/:blockId', tag: 'Landing Builder', summary: 'Update landing block', auth: 'bearer' },
  { method: 'DELETE', path: '/landing/blocks/:blockId', tag: 'Landing Builder', summary: 'Delete landing block', auth: 'bearer' },
  { method: 'GET', path: '/versions/:versionId/questions', tag: 'Questions', summary: 'List questions', auth: 'bearer' },
  { method: 'POST', path: '/versions/:versionId/questions', tag: 'Questions', summary: 'Create question', auth: 'bearer' },
  { method: 'PATCH', path: '/questions/:questionId', tag: 'Questions', summary: 'Update question', auth: 'bearer' },
  { method: 'DELETE', path: '/questions/:questionId', tag: 'Questions', summary: 'Delete question', auth: 'bearer' },
  { method: 'GET', path: '/questions/:questionId/options', tag: 'Questions', summary: 'List answer options', auth: 'bearer' },
  { method: 'POST', path: '/questions/:questionId/options', tag: 'Questions', summary: 'Create answer option', auth: 'bearer' },
  { method: 'PATCH', path: '/answer-options/:optionId', tag: 'Questions', summary: 'Update answer option', auth: 'bearer' },
  { method: 'DELETE', path: '/answer-options/:optionId', tag: 'Questions', summary: 'Delete answer option', auth: 'bearer' },
  { method: 'GET', path: '/versions/:versionId/logic-rules', tag: 'Questions', summary: 'List logic rules', auth: 'bearer' },
  { method: 'POST', path: '/versions/:versionId/logic-rules', tag: 'Questions', summary: 'Create logic rule', auth: 'bearer' },
  { method: 'PATCH', path: '/logic-rules/:ruleId', tag: 'Questions', summary: 'Update logic rule', auth: 'bearer' },
  { method: 'DELETE', path: '/logic-rules/:ruleId', tag: 'Questions', summary: 'Delete logic rule', auth: 'bearer' }
];

interface AssessmentsRouteDeps {
  service: AssessmentsService;
  jwtService: JwtService;
  openApi: OpenApiValidationProvider;
}

function getAuth(request: { auth?: { tenantId: string; userId: string; role: 'owner' | 'editor' | 'analyst' | 'viewer' } }) {
  if (!request.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return request.auth;
}

export async function registerAssessmentRoutes(app: FastifyInstance, deps: AssessmentsRouteDeps): Promise<void> {
  const authGuard = requireAuth(deps.jwtService);

  app.get(
    '/assessments',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/assessments')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const query = request.query as {
        status?: 'draft' | 'published' | 'archived';
        cursor?: string;
        limit?: number;
      };

      const listInput: {
        status?: 'draft' | 'published' | 'archived';
        cursor?: string;
        limit?: number;
      } = {};
      if (query.status) {
        listInput.status = query.status;
      }
      if (query.cursor) {
        listInput.cursor = query.cursor;
      }
      if (typeof query.limit === 'number') {
        listInput.limit = query.limit;
      }

      const result = await deps.service.listAssessments(auth.tenantId, listInput);
      reply.status(200).send(result);
    }
  );

  app.post(
    '/assessments',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/assessments')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const body = request.body as {
        name: string;
        slug: string;
        description?: string;
      };

      const createInput: {
        tenantId: string;
        actorUserId: string;
        actorRole: 'owner' | 'editor';
        name: string;
        slug: string;
        description?: string;
      } = {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        name: body.name,
        slug: body.slug
      };
      if (typeof body.description === 'string') {
        createInput.description = body.description;
      }

      const assessment = await deps.service.createAssessment(createInput);

      reply.status(201).send(assessment);
    }
  );

  app.get(
    '/assessments/:assessmentId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/assessments/{assessmentId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { assessmentId: string };
      const assessment = await deps.service.getAssessment(auth.tenantId, params.assessmentId);
      reply.status(200).send(assessment);
    }
  );

  app.patch(
    '/assessments/:assessmentId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/assessments/{assessmentId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);
      const params = request.params as { assessmentId: string };
      const body = request.body as Partial<{
        name: string;
        slug: string;
        description: string;
        status: 'draft' | 'published' | 'archived';
      }>;

      const assessment = await deps.service.updateAssessment({
        tenantId: auth.tenantId,
        assessmentId: params.assessmentId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(assessment);
    }
  );

  app.get(
    '/assessments/:assessmentId/versions',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/assessments/{assessmentId}/versions')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { assessmentId: string };
      const versions = await deps.service.listVersions(auth.tenantId, params.assessmentId);
      reply.status(200).send({ data: versions });
    }
  );

  app.post(
    '/assessments/:assessmentId/versions',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/assessments/{assessmentId}/versions')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { assessmentId: string };
      const body = request.body as { title: string; copyFromVersionId?: string };

      const createVersionInput: {
        tenantId: string;
        assessmentId: string;
        actorUserId: string;
        actorRole: 'owner' | 'editor';
        title: string;
        copyFromVersionId?: string;
      } = {
        tenantId: auth.tenantId,
        assessmentId: params.assessmentId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        title: body.title
      };
      if (typeof body.copyFromVersionId === 'string') {
        createVersionInput.copyFromVersionId = body.copyFromVersionId;
      }

      const version = await deps.service.createVersion(createVersionInput);

      reply.status(201).send(version);
    }
  );

  app.get(
    '/versions/:versionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/versions/{versionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { versionId: string };
      const version = await deps.service.getVersion(auth.tenantId, params.versionId);
      reply.status(200).send(version);
    }
  );

  app.patch(
    '/versions/:versionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/versions/{versionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const body = request.body as Partial<{
        title: string;
        introCopy: string;
        outroCopy: string;
        leadCaptureMode: 'start' | 'middle' | 'before_results';
        leadCaptureStep: number;
        runtimeSettings: Record<string, unknown>;
      }>;

      const version = await deps.service.updateVersion({
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(version);
    }
  );

  app.post(
    '/versions/:versionId/publish',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/versions/{versionId}/publish')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const version = await deps.service.publishVersion({
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor'
      });

      reply.status(200).send(version);
    }
  );

  app.get(
    '/versions/:versionId/landing',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/versions/{versionId}/landing')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { versionId: string };
      const landingPage = await deps.service.getLandingPage(auth.tenantId, params.versionId);
      reply.status(200).send(landingPage);
    }
  );

  app.put(
    '/versions/:versionId/landing',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PUT', '/versions/{versionId}/landing')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const body = request.body as Partial<{
        seoTitle: string;
        seoDescription: string;
        theme: Record<string, unknown>;
      }>;

      const landingPage = await deps.service.updateLandingPage({
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(landingPage);
    }
  );

  app.get(
    '/versions/:versionId/landing/blocks',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/versions/{versionId}/landing/blocks')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { versionId: string };
      const blocks = await deps.service.listLandingBlocks(auth.tenantId, params.versionId);
      reply.status(200).send({ data: blocks });
    }
  );

  app.post(
    '/versions/:versionId/landing/blocks',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/versions/{versionId}/landing/blocks')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const body = request.body as {
        type: string;
        position: number;
        config: Record<string, unknown>;
        isVisible?: boolean;
      };

      const createBlockInput: {
        tenantId: string;
        versionId: string;
        actorUserId: string;
        actorRole: 'owner' | 'editor';
        type: string;
        position: number;
        config: Record<string, unknown>;
        isVisible?: boolean;
      } = {
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        type: body.type,
        position: body.position,
        config: body.config
      };
      if (typeof body.isVisible === 'boolean') {
        createBlockInput.isVisible = body.isVisible;
      }

      const block = await deps.service.createLandingBlock(createBlockInput);

      reply.status(201).send(block);
    }
  );

  app.patch(
    '/landing/blocks/:blockId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/landing/blocks/{blockId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { blockId: string };
      const body = request.body as Partial<{
        type: string;
        position: number;
        config: Record<string, unknown>;
        isVisible: boolean;
      }>;

      const block = await deps.service.updateLandingBlock({
        tenantId: auth.tenantId,
        blockId: params.blockId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(block);
    }
  );

  app.delete(
    '/landing/blocks/:blockId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('DELETE', '/landing/blocks/{blockId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { blockId: string };
      await deps.service.deleteLandingBlock({
        tenantId: auth.tenantId,
        blockId: params.blockId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor'
      });

      reply.status(204).send();
    }
  );

  app.get(
    '/versions/:versionId/questions',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/versions/{versionId}/questions')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { versionId: string };
      const questions = await deps.service.listQuestions(auth.tenantId, params.versionId);
      reply.status(200).send({ data: questions });
    }
  );

  app.post(
    '/versions/:versionId/questions',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/versions/{versionId}/questions')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const body = request.body as {
        type: QuestionType;
        prompt: string;
        helpText?: string;
        isRequired?: boolean;
        position: number;
        weight?: number;
        minValue?: number;
        maxValue?: number;
        metadata?: Record<string, unknown>;
      };

      const createQuestionInput: {
        tenantId: string;
        versionId: string;
        actorUserId: string;
        actorRole: 'owner' | 'editor';
        type: QuestionType;
        prompt: string;
        helpText?: string;
        isRequired?: boolean;
        position: number;
        weight?: number;
        minValue?: number;
        maxValue?: number;
        metadata?: Record<string, unknown>;
      } = {
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        type: body.type,
        prompt: body.prompt,
        position: body.position,
      };
      if (typeof body.helpText === 'string') {
        createQuestionInput.helpText = body.helpText;
      }
      if (typeof body.isRequired === 'boolean') {
        createQuestionInput.isRequired = body.isRequired;
      }
      if (typeof body.weight === 'number') {
        createQuestionInput.weight = body.weight;
      }
      if (typeof body.minValue === 'number') {
        createQuestionInput.minValue = body.minValue;
      }
      if (typeof body.maxValue === 'number') {
        createQuestionInput.maxValue = body.maxValue;
      }
      if (body.metadata) {
        createQuestionInput.metadata = body.metadata;
      }

      const question = await deps.service.createQuestion(createQuestionInput);

      reply.status(201).send(question);
    }
  );

  app.patch(
    '/questions/:questionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/questions/{questionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { questionId: string };
      const body = request.body as Partial<{
        prompt: string;
        helpText: string;
        isRequired: boolean;
        position: number;
        weight: number;
        minValue: number;
        maxValue: number;
        metadata: Record<string, unknown>;
      }>;

      const question = await deps.service.updateQuestion({
        tenantId: auth.tenantId,
        questionId: params.questionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(question);
    }
  );

  app.delete(
    '/questions/:questionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('DELETE', '/questions/{questionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { questionId: string };
      await deps.service.deleteQuestion({
        tenantId: auth.tenantId,
        questionId: params.questionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor'
      });

      reply.status(204).send();
    }
  );

  app.get(
    '/questions/:questionId/options',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/questions/{questionId}/options')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { questionId: string };
      const options = await deps.service.listAnswerOptions(auth.tenantId, params.questionId);
      reply.status(200).send({ data: options });
    }
  );

  app.post(
    '/questions/:questionId/options',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/questions/{questionId}/options')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { questionId: string };
      const body = request.body as {
        label: string;
        value: string;
        scoreValue: number;
        position: number;
        metadata?: Record<string, unknown>;
      };

      const createOptionInput: {
        tenantId: string;
        questionId: string;
        actorUserId: string;
        actorRole: 'owner' | 'editor';
        label: string;
        value: string;
        scoreValue: number;
        position: number;
        metadata?: Record<string, unknown>;
      } = {
        tenantId: auth.tenantId,
        questionId: params.questionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        label: body.label,
        value: body.value,
        scoreValue: body.scoreValue,
        position: body.position
      };
      if (body.metadata) {
        createOptionInput.metadata = body.metadata;
      }

      const option = await deps.service.createAnswerOption(createOptionInput);

      reply.status(201).send(option);
    }
  );

  app.patch(
    '/answer-options/:optionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/answer-options/{optionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { optionId: string };
      const body = request.body as Partial<{
        label: string;
        value: string;
        scoreValue: number;
        position: number;
        metadata: Record<string, unknown>;
      }>;

      const option = await deps.service.updateAnswerOption({
        tenantId: auth.tenantId,
        optionId: params.optionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(option);
    }
  );

  app.delete(
    '/answer-options/:optionId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('DELETE', '/answer-options/{optionId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { optionId: string };
      await deps.service.deleteAnswerOption({
        tenantId: auth.tenantId,
        optionId: params.optionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor'
      });

      reply.status(204).send();
    }
  );

  app.get(
    '/versions/:versionId/logic-rules',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('GET', '/versions/{versionId}/logic-rules')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      const params = request.params as { versionId: string };
      const rules = await deps.service.listLogicRules(auth.tenantId, params.versionId);
      reply.status(200).send({ data: rules });
    }
  );

  app.post(
    '/versions/:versionId/logic-rules',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('POST', '/versions/{versionId}/logic-rules')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { versionId: string };
      const body = request.body as {
        name: string;
        priority?: number;
        ifExpression: Record<string, unknown>;
        thenAction: Record<string, unknown>;
        isActive?: boolean;
      };

      const createRuleInput: {
        tenantId: string;
        versionId: string;
        actorUserId: string;
        actorRole: 'owner' | 'editor';
        name: string;
        priority?: number;
        ifExpression: Record<string, unknown>;
        thenAction: Record<string, unknown>;
        isActive?: boolean;
      } = {
        tenantId: auth.tenantId,
        versionId: params.versionId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        name: body.name,
        ifExpression: body.ifExpression,
        thenAction: body.thenAction
      };
      if (typeof body.priority === 'number') {
        createRuleInput.priority = body.priority;
      }
      if (typeof body.isActive === 'boolean') {
        createRuleInput.isActive = body.isActive;
      }

      const rule = await deps.service.createLogicRule(createRuleInput);

      reply.status(201).send(rule);
    }
  );

  app.patch(
    '/logic-rules/:ruleId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('PATCH', '/logic-rules/{ruleId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { ruleId: string };
      const body = request.body as Partial<{
        name: string;
        priority: number;
        ifExpression: Record<string, unknown>;
        thenAction: Record<string, unknown>;
        isActive: boolean;
      }>;

      const rule = await deps.service.updateLogicRule({
        tenantId: auth.tenantId,
        ruleId: params.ruleId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor',
        patch: body
      });

      reply.status(200).send(rule);
    }
  );

  app.delete(
    '/logic-rules/:ruleId',
    {
      preHandler: [authGuard],
      schema: deps.openApi.getRouteSchema('DELETE', '/logic-rules/{ruleId}')
    },
    async (request, reply) => {
      const auth = getAuth(request);
      requireRole(request, ['owner', 'editor']);

      const params = request.params as { ruleId: string };
      await deps.service.deleteLogicRule({
        tenantId: auth.tenantId,
        ruleId: params.ruleId,
        actorUserId: auth.userId,
        actorRole: auth.role as 'owner' | 'editor'
      });

      reply.status(204).send();
    }
  );
}

type QuestionType = 'single_choice' | 'multi_choice' | 'scale' | 'numeric' | 'short_text';
