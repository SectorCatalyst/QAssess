import { AppError, toUniqueConflictAppError } from '../../lib/errors.js';
import { recordAuditLog } from '../../lib/audit.js';
import type { DatabaseClient } from '../../lib/db.js';

import type {
  AssessmentRecord,
  AssessmentStatus,
  AssessmentVersionRecord,
  AssessmentsRepository,
  LandingPageRecord,
  LogicRuleRecord,
  PageBlockRecord,
  QuestionRecord,
  QuestionType
} from './repository.js';

type JsonObject = Record<string, unknown>;

type MutatingRole = 'owner' | 'editor';

interface ServiceDeps {
  db: DatabaseClient;
  repository: AssessmentsRepository;
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

interface PaginationResult<T> {
  data: T[];
  pagination: {
    hasMore: boolean;
    nextCursor?: string;
  };
}

function assertPresent<T>(value: T | null | undefined, notFoundCode: string, message: string): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new AppError(404, notFoundCode, message);
  }
  return value as NonNullable<T>;
}

function mapDatabaseError(error: unknown, fallbackMessage: string, fallbackCode = 'CONFLICT'): never {
  const conflict = toUniqueConflictAppError(error, {
    code: fallbackCode,
    message: fallbackMessage
  });
  if (conflict) {
    throw conflict;
  }
  throw error;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): CursorPayload | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded) as Partial<CursorPayload>;
    if (typeof payload.createdAt === 'string' && typeof payload.id === 'string') {
      return {
        createdAt: payload.createdAt,
        id: payload.id
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function remapQuestionIds(value: unknown, questionIdMap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return questionIdMap.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => remapQuestionIds(entry, questionIdMap));
  }

  if (isObject(value)) {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = remapQuestionIds(item, questionIdMap);
    }
    return output;
  }

  return value;
}

export function createAssessmentsService(deps: ServiceDeps) {
  const { db, repository } = deps;

  async function getEditableVersion(tenantId: string, versionId: string): Promise<AssessmentVersionRecord> {
    const version = assertPresent(
      await repository.getVersionById(tenantId, versionId),
      'VERSION_NOT_FOUND',
      'Assessment version not found'
    );
    if (version.isPublished) {
      throw new AppError(409, 'VERSION_LOCKED', 'Published versions cannot be modified');
    }
    return version;
  }

  async function getEditableQuestion(tenantId: string, questionId: string): Promise<QuestionRecord> {
    const question = assertPresent(await repository.getQuestionById(tenantId, questionId), 'QUESTION_NOT_FOUND', 'Question not found');
    await getEditableVersion(tenantId, question.assessmentVersionId);
    return question;
  }

  async function copyVersionContent(
    tenantId: string,
    sourceVersionId: string,
    destinationVersionId: string,
    executor: Parameters<DatabaseClient['withTransaction']>[0] extends (client: infer T) => Promise<unknown> ? T : never
  ): Promise<void> {
    const sourceQuestions = await repository.listQuestionsByVersion(sourceVersionId, executor);
    const questionIdMap = new Map<string, string>();

    for (const sourceQuestion of sourceQuestions) {
      const clonedQuestion = await repository.createQuestion(
        {
          versionId: destinationVersionId,
          type: sourceQuestion.type,
          prompt: sourceQuestion.prompt,
          helpText: sourceQuestion.helpText,
          isRequired: sourceQuestion.isRequired,
          position: sourceQuestion.position,
          weight: sourceQuestion.weight,
          minValue: sourceQuestion.minValue,
          maxValue: sourceQuestion.maxValue,
          metadata: sourceQuestion.metadata
        },
        executor
      );

      questionIdMap.set(sourceQuestion.id, clonedQuestion.id);

      const sourceOptions = await repository.listAnswerOptionsByQuestion(sourceQuestion.id, executor);
      for (const sourceOption of sourceOptions) {
        await repository.createAnswerOption(
          {
            questionId: clonedQuestion.id,
            label: sourceOption.label,
            value: sourceOption.value,
            scoreValue: sourceOption.scoreValue,
            position: sourceOption.position,
            metadata: sourceOption.metadata
          },
          executor
        );
      }
    }

    const sourceRules = await repository.listLogicRulesByVersion(sourceVersionId, executor);
    for (const sourceRule of sourceRules) {
      await repository.createLogicRule(
        {
          versionId: destinationVersionId,
          name: sourceRule.name,
          priority: sourceRule.priority,
          ifExpression: remapQuestionIds(sourceRule.ifExpression, questionIdMap) as JsonObject,
          thenAction: remapQuestionIds(sourceRule.thenAction, questionIdMap) as JsonObject,
          isActive: sourceRule.isActive
        },
        executor
      );
    }

    const sourceLanding = await repository.getLandingPageByVersion(tenantId, sourceVersionId, executor);
    if (!sourceLanding) {
      return;
    }

    const landingCopyPatch: {
      seoTitle?: string;
      seoDescription?: string;
      theme: Record<string, unknown>;
    } = {
      theme: sourceLanding.theme
    };
    if (typeof sourceLanding.seoTitle === 'string') {
      landingCopyPatch.seoTitle = sourceLanding.seoTitle;
    }
    if (typeof sourceLanding.seoDescription === 'string') {
      landingCopyPatch.seoDescription = sourceLanding.seoDescription;
    }

    await repository.updateLandingPage(
      tenantId,
      destinationVersionId,
      landingCopyPatch,
      executor
    );

    const destinationLanding = assertPresent(
      await repository.getLandingPageByVersion(tenantId, destinationVersionId, executor),
      'LANDING_PAGE_NOT_FOUND',
      'Landing page not found'
    );
    const sourceBlocks = await repository.listPageBlocksByLanding(sourceLanding.id, executor);
    for (const sourceBlock of sourceBlocks) {
      await repository.createPageBlock(
        {
          landingPageId: destinationLanding.id,
          type: sourceBlock.type,
          position: sourceBlock.position,
          config: sourceBlock.config,
          isVisible: sourceBlock.isVisible
        },
        executor
      );
    }
  }

  return {
    async listAssessments(
      tenantId: string,
      input: { status?: AssessmentStatus; cursor?: string; limit?: number }
    ): Promise<PaginationResult<AssessmentRecord>> {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const cursor = decodeCursor(input.cursor);

      const rows = await repository.listAssessments(tenantId, {
        status: input.status,
        cursorCreatedAt: cursor?.createdAt,
        cursorId: cursor?.id,
        limit: limit + 1
      });

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const last = data[data.length - 1];

      const pagination: PaginationResult<AssessmentRecord>['pagination'] = {
        hasMore
      };
      if (hasMore && last) {
        pagination.nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
      }

      return {
        data,
        pagination
      };
    },

    async createAssessment(input: {
      tenantId: string;
      actorUserId: string;
      name: string;
      slug: string;
      description?: string;
      actorRole: MutatingRole;
    }): Promise<AssessmentRecord> {
      try {
        const assessment = await repository.createAssessment({
          tenantId: input.tenantId,
          name: input.name,
          slug: input.slug,
          description: input.description,
          createdBy: input.actorUserId
        });

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'assessment.create',
          targetType: 'assessment',
          targetId: assessment.id,
          metadata: {
            actorRole: input.actorRole,
            slug: assessment.slug
          }
        });

        return assessment;
      } catch (error) {
        mapDatabaseError(error, 'Assessment slug already exists for this tenant', 'ASSESSMENT_SLUG_CONFLICT');
      }
    },

    async getAssessment(tenantId: string, assessmentId: string): Promise<AssessmentRecord> {
      const assessment = await repository.getAssessmentById(tenantId, assessmentId);
      return assertPresent(assessment, 'ASSESSMENT_NOT_FOUND', 'Assessment not found');
    },

    async updateAssessment(input: {
      tenantId: string;
      assessmentId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{ name: string; slug: string; description: string; status: AssessmentStatus }>;
    }): Promise<AssessmentRecord> {
      try {
        const updated = assertPresent(
          await repository.updateAssessment(input.tenantId, input.assessmentId, input.patch),
          'ASSESSMENT_NOT_FOUND',
          'Assessment not found'
        );

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'assessment.update',
          targetType: 'assessment',
          targetId: updated.id,
          metadata: {
            actorRole: input.actorRole,
            fields: Object.keys(input.patch)
          }
        });

        return updated;
      } catch (error) {
        mapDatabaseError(error, 'Assessment slug already exists for this tenant', 'ASSESSMENT_SLUG_CONFLICT');
      }
    },

    async listVersions(tenantId: string, assessmentId: string): Promise<AssessmentVersionRecord[]> {
      const assessment = await repository.getAssessmentById(tenantId, assessmentId);
      assertPresent(assessment, 'ASSESSMENT_NOT_FOUND', 'Assessment not found');
      return repository.listVersions(tenantId, assessmentId);
    },

    async getVersion(tenantId: string, versionId: string): Promise<AssessmentVersionRecord> {
      const version = await repository.getVersionById(tenantId, versionId);
      return assertPresent(version, 'VERSION_NOT_FOUND', 'Assessment version not found');
    },

    async createVersion(input: {
      tenantId: string;
      assessmentId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      title: string;
      copyFromVersionId?: string;
    }): Promise<AssessmentVersionRecord> {
      const assessment = await repository.getAssessmentById(input.tenantId, input.assessmentId);
      assertPresent(assessment, 'ASSESSMENT_NOT_FOUND', 'Assessment not found');

      return db.withTransaction(async (client) => {
        let sourceVersion: AssessmentVersionRecord | null = null;
        if (input.copyFromVersionId) {
          sourceVersion = await repository.getVersionByAssessment(
            input.tenantId,
            input.assessmentId,
            input.copyFromVersionId,
            client
          );
          assertPresent(sourceVersion, 'VERSION_NOT_FOUND', 'Source version not found');
        }

        const nextVersionNo = await repository.getNextVersionNumber(input.assessmentId, client);
        const createdVersion = await repository.createVersion(
          {
            assessmentId: input.assessmentId,
            versionNo: nextVersionNo,
            title: input.title,
            introCopy: sourceVersion?.introCopy,
            outroCopy: sourceVersion?.outroCopy,
            leadCaptureMode: sourceVersion?.leadCaptureMode,
            leadCaptureStep: sourceVersion?.leadCaptureStep,
            runtimeSettings: sourceVersion?.runtimeSettings,
            createdBy: input.actorUserId
          },
          client
        );

        await repository.ensureLandingPage(input.tenantId, createdVersion.id, client);

        if (sourceVersion) {
          await copyVersionContent(input.tenantId, sourceVersion.id, createdVersion.id, client);
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'version.create',
          targetType: 'assessment_version',
          targetId: createdVersion.id,
          metadata: {
            actorRole: input.actorRole,
            assessmentId: input.assessmentId,
            copyFromVersionId: input.copyFromVersionId ?? null
          }
        });

        return createdVersion;
      });
    },

    async updateVersion(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{
        title: string;
        introCopy: string;
        outroCopy: string;
        leadCaptureMode: 'start' | 'middle' | 'before_results';
        leadCaptureStep: number;
        runtimeSettings: JsonObject;
      }>;
    }): Promise<AssessmentVersionRecord> {
      await getEditableVersion(input.tenantId, input.versionId);

      const updated = await repository.updateVersion(input.tenantId, input.versionId, input.patch);
      const version = assertPresent(updated, 'VERSION_NOT_FOUND', 'Assessment version not found');

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'version.update',
        targetType: 'assessment_version',
        targetId: version.id,
        metadata: {
          actorRole: input.actorRole,
          fields: Object.keys(input.patch)
        }
      });

      return version;
    },

    async publishVersion(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
    }): Promise<AssessmentVersionRecord> {
      return db.withTransaction(async (client) => {
        const version = await repository.getVersionById(input.tenantId, input.versionId, client);
        const existing = assertPresent(version, 'VERSION_NOT_FOUND', 'Assessment version not found');

        await repository.clearPublishedVersions(existing.assessmentId, client);
        await repository.publishVersion(existing.id, client);
        await repository.updateAssessmentStatus(existing.assessmentId, 'published', client);

        const updated = await repository.getVersionById(input.tenantId, existing.id, client);
        const published = assertPresent(updated, 'VERSION_NOT_FOUND', 'Assessment version not found');

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'version.publish',
          targetType: 'assessment_version',
          targetId: published.id,
          metadata: {
            actorRole: input.actorRole,
            assessmentId: published.assessmentId
          }
        });

        return published;
      });
    },

    async getLandingPage(tenantId: string, versionId: string): Promise<LandingPageRecord> {
      await this.getVersion(tenantId, versionId);
      const landing = assertPresent(
        await repository.ensureLandingPage(tenantId, versionId),
        'LANDING_PAGE_NOT_FOUND',
        'Landing page not found'
      );
      const blocks = await repository.listPageBlocks(tenantId, versionId);
      return {
        ...landing,
        blocks
      };
    },

    async updateLandingPage(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{
        seoTitle: string;
        seoDescription: string;
        theme: JsonObject;
      }>;
    }): Promise<LandingPageRecord> {
      await getEditableVersion(input.tenantId, input.versionId);

      await repository.ensureLandingPage(input.tenantId, input.versionId);
      const updated = assertPresent(
        await repository.updateLandingPage(input.tenantId, input.versionId, input.patch),
        'LANDING_PAGE_NOT_FOUND',
        'Landing page not found'
      );
      const blocks = await repository.listPageBlocks(input.tenantId, input.versionId);

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'landing_page.update',
        targetType: 'landing_page',
        targetId: updated.id,
        metadata: {
          actorRole: input.actorRole,
          versionId: input.versionId,
          fields: Object.keys(input.patch)
        }
      });

      return {
        ...updated,
        blocks
      };
    },

    async listLandingBlocks(tenantId: string, versionId: string): Promise<PageBlockRecord[]> {
      await this.getVersion(tenantId, versionId);
      await repository.ensureLandingPage(tenantId, versionId);
      return repository.listPageBlocks(tenantId, versionId);
    },

    async createLandingBlock(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      type: string;
      position: number;
      config: JsonObject;
      isVisible?: boolean;
    }): Promise<PageBlockRecord> {
      await getEditableVersion(input.tenantId, input.versionId);

      const landing = assertPresent(
        await repository.ensureLandingPage(input.tenantId, input.versionId),
        'LANDING_PAGE_NOT_FOUND',
        'Landing page not found'
      );

      try {
        const block = await repository.createPageBlock({
          landingPageId: landing.id,
          type: input.type,
          position: input.position,
          config: input.config,
          isVisible: input.isVisible ?? true
        });

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'page_block.create',
          targetType: 'page_block',
          targetId: block.id,
          metadata: {
            actorRole: input.actorRole,
            versionId: input.versionId
          }
        });

        return block;
      } catch (error) {
        mapDatabaseError(error, 'Landing block position already exists for this page', 'LANDING_BLOCK_POSITION_CONFLICT');
      }
    },

    async updateLandingBlock(input: {
      tenantId: string;
      blockId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{
        type: string;
        position: number;
        config: JsonObject;
        isVisible: boolean;
      }>;
    }): Promise<PageBlockRecord> {
      const existing = assertPresent(
        await repository.getPageBlockById(input.tenantId, input.blockId),
        'BLOCK_NOT_FOUND',
        'Landing block not found'
      );
      await getEditableVersion(input.tenantId, existing.assessmentVersionId);

      try {
        const updated = assertPresent(
          await repository.updatePageBlock(input.tenantId, input.blockId, input.patch),
          'BLOCK_NOT_FOUND',
          'Landing block not found'
        );

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'page_block.update',
          targetType: 'page_block',
          targetId: updated.id,
          metadata: {
            actorRole: input.actorRole,
            fields: Object.keys(input.patch)
          }
        });

        return updated;
      } catch (error) {
        mapDatabaseError(error, 'Landing block position already exists for this page', 'LANDING_BLOCK_POSITION_CONFLICT');
      }
    },

    async deleteLandingBlock(input: {
      tenantId: string;
      blockId: string;
      actorUserId: string;
      actorRole: MutatingRole;
    }): Promise<void> {
      const existing = assertPresent(
        await repository.getPageBlockById(input.tenantId, input.blockId),
        'BLOCK_NOT_FOUND',
        'Landing block not found'
      );
      await getEditableVersion(input.tenantId, existing.assessmentVersionId);

      const deleted = await repository.deletePageBlock(input.tenantId, input.blockId);
      if (!deleted) {
        throw new AppError(404, 'BLOCK_NOT_FOUND', 'Landing block not found');
      }

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'page_block.delete',
        targetType: 'page_block',
        targetId: input.blockId,
        metadata: {
          actorRole: input.actorRole
        }
      });
    },

    async listQuestions(tenantId: string, versionId: string): Promise<QuestionRecord[]> {
      await this.getVersion(tenantId, versionId);
      return repository.listQuestions(tenantId, versionId);
    },

    async createQuestion(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      type: QuestionType;
      prompt: string;
      helpText?: string;
      isRequired?: boolean;
      position: number;
      weight?: number;
      minValue?: number;
      maxValue?: number;
      metadata?: JsonObject;
    }): Promise<QuestionRecord> {
      await getEditableVersion(input.tenantId, input.versionId);

      try {
        const created = await repository.createQuestion({
          versionId: input.versionId,
          type: input.type,
          prompt: input.prompt,
          helpText: input.helpText,
          isRequired: input.isRequired ?? true,
          position: input.position,
          weight: input.weight ?? 1,
          minValue: input.minValue,
          maxValue: input.maxValue,
          metadata: input.metadata
        });

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'question.create',
          targetType: 'question',
          targetId: created.id,
          metadata: {
            actorRole: input.actorRole,
            versionId: input.versionId
          }
        });

        return created;
      } catch (error) {
        mapDatabaseError(error, 'Question position already exists for this version', 'QUESTION_POSITION_CONFLICT');
      }
    },

    async updateQuestion(input: {
      tenantId: string;
      questionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{
        prompt: string;
        helpText: string;
        isRequired: boolean;
        position: number;
        weight: number;
        minValue: number;
        maxValue: number;
        metadata: JsonObject;
      }>;
    }): Promise<QuestionRecord> {
      await getEditableQuestion(input.tenantId, input.questionId);

      try {
        const updated = await repository.updateQuestion(input.tenantId, input.questionId, input.patch);
        const question = assertPresent(updated, 'QUESTION_NOT_FOUND', 'Question not found');

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'question.update',
          targetType: 'question',
          targetId: question.id,
          metadata: {
            actorRole: input.actorRole,
            fields: Object.keys(input.patch)
          }
        });

        return question;
      } catch (error) {
        mapDatabaseError(error, 'Question position already exists for this version', 'QUESTION_POSITION_CONFLICT');
      }
    },

    async deleteQuestion(input: {
      tenantId: string;
      questionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
    }): Promise<void> {
      await getEditableQuestion(input.tenantId, input.questionId);

      const deleted = await repository.deleteQuestion(input.tenantId, input.questionId);
      if (!deleted) {
        throw new AppError(404, 'QUESTION_NOT_FOUND', 'Question not found');
      }

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'question.delete',
        targetType: 'question',
        targetId: input.questionId,
        metadata: {
          actorRole: input.actorRole
        }
      });
    },

    async listAnswerOptions(tenantId: string, questionId: string) {
      const question = await repository.getQuestionById(tenantId, questionId);
      assertPresent(question, 'QUESTION_NOT_FOUND', 'Question not found');
      return repository.listAnswerOptions(tenantId, questionId);
    },

    async createAnswerOption(input: {
      tenantId: string;
      questionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      label: string;
      value: string;
      scoreValue: number;
      position: number;
      metadata?: JsonObject;
    }) {
      const question = await getEditableQuestion(input.tenantId, input.questionId);

      try {
        const option = await repository.createAnswerOption({
          questionId: question.id,
          label: input.label,
          value: input.value,
          scoreValue: input.scoreValue,
          position: input.position,
          metadata: input.metadata
        });

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'answer_option.create',
          targetType: 'answer_option',
          targetId: option.id,
          metadata: {
            actorRole: input.actorRole,
            questionId: input.questionId
          }
        });

        return option;
      } catch (error) {
        mapDatabaseError(error, 'Answer option position already exists for this question', 'ANSWER_OPTION_POSITION_CONFLICT');
      }
    },

    async updateAnswerOption(input: {
      tenantId: string;
      optionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{
        label: string;
        value: string;
        scoreValue: number;
        position: number;
        metadata: JsonObject;
      }>;
    }) {
      const existing = assertPresent(
        await repository.getAnswerOptionById(input.tenantId, input.optionId),
        'ANSWER_OPTION_NOT_FOUND',
        'Answer option not found'
      );

      await getEditableQuestion(input.tenantId, existing.questionId);

      try {
        const updated = await repository.updateAnswerOption(input.tenantId, input.optionId, input.patch);
        const option = assertPresent(updated, 'ANSWER_OPTION_NOT_FOUND', 'Answer option not found');

        await recordAuditLog(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'answer_option.update',
          targetType: 'answer_option',
          targetId: option.id,
          metadata: {
            actorRole: input.actorRole,
            fields: Object.keys(input.patch)
          }
        });

        return option;
      } catch (error) {
        mapDatabaseError(error, 'Answer option position already exists for this question', 'ANSWER_OPTION_POSITION_CONFLICT');
      }
    },

    async deleteAnswerOption(input: {
      tenantId: string;
      optionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
    }): Promise<void> {
      const existing = assertPresent(
        await repository.getAnswerOptionById(input.tenantId, input.optionId),
        'ANSWER_OPTION_NOT_FOUND',
        'Answer option not found'
      );

      await getEditableQuestion(input.tenantId, existing.questionId);

      const deleted = await repository.deleteAnswerOption(input.tenantId, input.optionId);
      if (!deleted) {
        throw new AppError(404, 'ANSWER_OPTION_NOT_FOUND', 'Answer option not found');
      }

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'answer_option.delete',
        targetType: 'answer_option',
        targetId: input.optionId,
        metadata: {
          actorRole: input.actorRole
        }
      });
    },

    async listLogicRules(tenantId: string, versionId: string): Promise<LogicRuleRecord[]> {
      await this.getVersion(tenantId, versionId);
      return repository.listLogicRules(tenantId, versionId);
    },

    async createLogicRule(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      name: string;
      priority?: number;
      ifExpression: JsonObject;
      thenAction: JsonObject;
      isActive?: boolean;
    }) {
      await getEditableVersion(input.tenantId, input.versionId);

      const created = await repository.createLogicRule({
        versionId: input.versionId,
        name: input.name,
        priority: input.priority ?? 100,
        ifExpression: input.ifExpression,
        thenAction: input.thenAction,
        isActive: input.isActive ?? true
      });

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'logic_rule.create',
        targetType: 'logic_rule',
        targetId: created.id,
        metadata: {
          actorRole: input.actorRole,
          versionId: input.versionId
        }
      });

      return created;
    },

    async updateLogicRule(input: {
      tenantId: string;
      ruleId: string;
      actorUserId: string;
      actorRole: MutatingRole;
      patch: Partial<{
        name: string;
        priority: number;
        ifExpression: JsonObject;
        thenAction: JsonObject;
        isActive: boolean;
      }>;
    }) {
      const existing = assertPresent(
        await repository.getLogicRuleById(input.tenantId, input.ruleId),
        'LOGIC_RULE_NOT_FOUND',
        'Logic rule not found'
      );

      await getEditableVersion(input.tenantId, existing.assessmentVersionId);

      const updated = await repository.updateLogicRule(input.tenantId, input.ruleId, input.patch);
      const rule = assertPresent(updated, 'LOGIC_RULE_NOT_FOUND', 'Logic rule not found');

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'logic_rule.update',
        targetType: 'logic_rule',
        targetId: rule.id,
        metadata: {
          actorRole: input.actorRole,
          fields: Object.keys(input.patch)
        }
      });

      return rule;
    },

    async deleteLogicRule(input: {
      tenantId: string;
      ruleId: string;
      actorUserId: string;
      actorRole: MutatingRole;
    }): Promise<void> {
      const existing = assertPresent(
        await repository.getLogicRuleById(input.tenantId, input.ruleId),
        'LOGIC_RULE_NOT_FOUND',
        'Logic rule not found'
      );

      await getEditableVersion(input.tenantId, existing.assessmentVersionId);

      const deleted = await repository.deleteLogicRule(input.tenantId, input.ruleId);
      if (!deleted) {
        throw new AppError(404, 'LOGIC_RULE_NOT_FOUND', 'Logic rule not found');
      }

      await recordAuditLog(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'logic_rule.delete',
        targetType: 'logic_rule',
        targetId: input.ruleId,
        metadata: {
          actorRole: input.actorRole
        }
      });
    }
  };
}

export type AssessmentsService = ReturnType<typeof createAssessmentsService>;
