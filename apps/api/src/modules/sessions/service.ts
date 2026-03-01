import type { PoolClient, QueryResultRow } from 'pg';

import { recordAuditLog } from '../../lib/audit.js';
import type { DatabaseClient } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { enqueueWebhookEvent } from '../../lib/webhooks.js';
import type { AssessmentsRepository } from '../assessments/repository.js';

type QueryExecutor = DatabaseClient | PoolClient;
type JsonObject = Record<string, unknown>;
type ResponseAnswer = string | number | string[] | JsonObject;
type SessionStatus = 'in_progress' | 'completed' | 'abandoned';
type PdfJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

interface SessionContextRow {
  sessionId: string;
  tenantId: string;
  assessmentId: string;
  assessmentVersionId: string;
  leadId: string | null;
  status: SessionStatus;
  currentQuestionPosition: number | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
  runtimeContext: unknown;
}

interface SessionRow {
  id: string;
  assessmentId: string;
  assessmentVersionId: string;
  leadId: string | null;
  status: SessionStatus;
  currentQuestionPosition: number | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

interface LeadRow {
  id: string;
  tenantId: string;
  assessmentId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  company: string | null;
  customFields: unknown;
  consent: boolean;
  consentAt: Date | string | null;
  createdAt: Date | string;
}

interface ResponseRow {
  id: string;
  sessionId: string;
  questionId: string;
  answer: unknown;
  computedScore: string | number;
  answeredAt: Date | string;
}

interface ResultRow {
  sessionId: string;
  rawScore: string | number;
  normalizedScore: string | number;
  maxPossibleRawScore: string | number;
  breakdown: unknown;
  recommendations: unknown;
  generatedReport: unknown;
  finalizedAt: Date | string;
  scoreBandId: string | null;
  scoreBandAssessmentVersionId: string | null;
  scoreBandLabel: string | null;
  scoreBandMinScore: string | number | null;
  scoreBandMaxScore: string | number | null;
  scoreBandColorHex: string | null;
  scoreBandSummary: string | null;
  scoreBandRecommendationTemplate: string | null;
  scoreBandPosition: number | null;
}

interface PdfJobRow {
  id: string;
  sessionId: string;
  status: PdfJobStatus;
  storageKey: string | null;
  fileUrl: string | null;
  errorMessage: string | null;
  attemptCount: number;
  queuedAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

interface QuestionScoreRow {
  id: string;
  type: 'single_choice' | 'multi_choice' | 'scale' | 'numeric' | 'short_text';
  position: number;
  weight: string | number;
  minValue: string | number | null;
  maxValue: string | number | null;
}

interface ServiceDeps {
  db: DatabaseClient;
  assessmentsRepository: AssessmentsRepository;
}

function normalizeAnswerForQuestion(questionType: QuestionScoreRow['type'], answer: ResponseAnswer): ResponseAnswer {
  if (questionType === 'multi_choice' && typeof answer === 'string') {
    return [answer];
  }
  return answer;
}

function asExecutor(executor: QueryExecutor): {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
} {
  return executor as unknown as {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  };
}

function toIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function mapSession(row: SessionRow): {
  id: string;
  assessmentId: string;
  assessmentVersionId: string;
  leadId?: string;
  status: SessionStatus;
  currentQuestionPosition?: number;
  startedAt: string;
  completedAt?: string;
} {
  const mapped: {
    id: string;
    assessmentId: string;
    assessmentVersionId: string;
    leadId?: string;
    status: SessionStatus;
    currentQuestionPosition?: number;
    startedAt: string;
    completedAt?: string;
  } = {
    id: row.id,
    assessmentId: row.assessmentId,
    assessmentVersionId: row.assessmentVersionId,
    status: row.status,
    startedAt: toIso(row.startedAt)
  };
  if (row.leadId !== null) {
    mapped.leadId = row.leadId;
  }
  if (row.currentQuestionPosition !== null) {
    mapped.currentQuestionPosition = row.currentQuestionPosition;
  }
  if (row.completedAt !== null) {
    mapped.completedAt = toIso(row.completedAt);
  }
  return mapped;
}

function mapLead(row: LeadRow): {
  id: string;
  tenantId: string;
  assessmentId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  customFields: JsonObject;
  consent: boolean;
  consentAt?: string;
  createdAt: string;
} {
  const mapped: {
    id: string;
    tenantId: string;
    assessmentId: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    company?: string;
    customFields: JsonObject;
    consent: boolean;
    consentAt?: string;
    createdAt: string;
  } = {
    id: row.id,
    tenantId: row.tenantId,
    assessmentId: row.assessmentId,
    customFields: asObject(row.customFields),
    consent: row.consent,
    createdAt: toIso(row.createdAt)
  };
  if (row.email !== null) {
    mapped.email = row.email;
  }
  if (row.firstName !== null) {
    mapped.firstName = row.firstName;
  }
  if (row.lastName !== null) {
    mapped.lastName = row.lastName;
  }
  if (row.phone !== null) {
    mapped.phone = row.phone;
  }
  if (row.company !== null) {
    mapped.company = row.company;
  }
  if (row.consentAt !== null) {
    mapped.consentAt = toIso(row.consentAt);
  }
  return mapped;
}

function mapResponse(row: ResponseRow): {
  id: string;
  sessionId: string;
  questionId: string;
  answer: ResponseAnswer;
  computedScore: number;
  answeredAt: string;
} {
  return {
    id: row.id,
    sessionId: row.sessionId,
    questionId: row.questionId,
    answer: row.answer as ResponseAnswer,
    computedScore: toNumber(row.computedScore),
    answeredAt: toIso(row.answeredAt)
  };
}

function mapPdfJob(row: PdfJobRow): {
  id: string;
  sessionId: string;
  status: PdfJobStatus;
  storageKey?: string;
  fileUrl?: string;
  errorMessage?: string;
  attemptCount: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
} {
  const mapped: {
    id: string;
    sessionId: string;
    status: PdfJobStatus;
    storageKey?: string;
    fileUrl?: string;
    errorMessage?: string;
    attemptCount: number;
    queuedAt: string;
    startedAt?: string;
    completedAt?: string;
  } = {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    attemptCount: row.attemptCount,
    queuedAt: toIso(row.queuedAt)
  };
  if (row.storageKey !== null) {
    mapped.storageKey = row.storageKey;
  }
  if (row.fileUrl !== null) {
    mapped.fileUrl = row.fileUrl;
  }
  if (row.errorMessage !== null) {
    mapped.errorMessage = row.errorMessage;
  }
  if (row.startedAt !== null) {
    mapped.startedAt = toIso(row.startedAt);
  }
  if (row.completedAt !== null) {
    mapped.completedAt = toIso(row.completedAt);
  }
  return mapped;
}

function mapResult(row: ResultRow): {
  sessionId: string;
  rawScore: number;
  normalizedScore: number;
  maxPossibleRawScore: number;
  scoreBand?: {
    id: string;
    assessmentVersionId: string;
    label: string;
    minScore: number;
    maxScore: number;
    colorHex?: string;
    summary?: string;
    recommendationTemplate?: string;
    position: number;
  };
  breakdown: JsonObject;
  recommendations: string[];
  generatedReport: JsonObject;
  finalizedAt: string;
} {
  const mapped: {
    sessionId: string;
    rawScore: number;
    normalizedScore: number;
    maxPossibleRawScore: number;
    scoreBand?: {
      id: string;
      assessmentVersionId: string;
      label: string;
      minScore: number;
      maxScore: number;
      colorHex?: string;
      summary?: string;
      recommendationTemplate?: string;
      position: number;
    };
    breakdown: JsonObject;
    recommendations: string[];
    generatedReport: JsonObject;
    finalizedAt: string;
  } = {
    sessionId: row.sessionId,
    rawScore: toNumber(row.rawScore),
    normalizedScore: toNumber(row.normalizedScore),
    maxPossibleRawScore: toNumber(row.maxPossibleRawScore),
    breakdown: asObject(row.breakdown),
    recommendations: asStringArray(row.recommendations),
    generatedReport: asObject(row.generatedReport),
    finalizedAt: toIso(row.finalizedAt)
  };

  if (
    row.scoreBandId !== null &&
    row.scoreBandAssessmentVersionId !== null &&
    row.scoreBandLabel !== null &&
    row.scoreBandMinScore !== null &&
    row.scoreBandMaxScore !== null &&
    row.scoreBandPosition !== null
  ) {
    const band: {
      id: string;
      assessmentVersionId: string;
      label: string;
      minScore: number;
      maxScore: number;
      colorHex?: string;
      summary?: string;
      recommendationTemplate?: string;
      position: number;
    } = {
      id: row.scoreBandId,
      assessmentVersionId: row.scoreBandAssessmentVersionId,
      label: row.scoreBandLabel,
      minScore: toNumber(row.scoreBandMinScore),
      maxScore: toNumber(row.scoreBandMaxScore),
      position: row.scoreBandPosition
    };
    if (row.scoreBandColorHex !== null) {
      band.colorHex = row.scoreBandColorHex;
    }
    if (row.scoreBandSummary !== null) {
      band.summary = row.scoreBandSummary;
    }
    if (row.scoreBandRecommendationTemplate !== null) {
      band.recommendationTemplate = row.scoreBandRecommendationTemplate;
    }
    mapped.scoreBand = band;
  }

  return mapped;
}

async function getSessionContext(sessionId: string, executor: QueryExecutor): Promise<SessionContextRow | null> {
  const result = await asExecutor(executor).query<SessionContextRow>(
    `
      SELECT
        s.id AS "sessionId",
        a.tenant_id AS "tenantId",
        s.assessment_id AS "assessmentId",
        s.assessment_version_id AS "assessmentVersionId",
        s.lead_id AS "leadId",
        s.status::text AS status,
        s.current_question_position AS "currentQuestionPosition",
        s.started_at AS "startedAt",
        s.completed_at AS "completedAt",
        s.runtime_context AS "runtimeContext"
      FROM sessions s
      INNER JOIN assessments a ON a.id = s.assessment_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rows[0] ?? null;
}

async function getResultBySession(sessionId: string, executor: QueryExecutor): Promise<ResultRow | null> {
  const result = await asExecutor(executor).query<ResultRow>(
    `
      SELECT
        r.session_id AS "sessionId",
        r.raw_score AS "rawScore",
        r.normalized_score AS "normalizedScore",
        r.max_possible_raw_score AS "maxPossibleRawScore",
        r.breakdown,
        r.recommendations,
        r.generated_report AS "generatedReport",
        r.finalized_at AS "finalizedAt",
        sb.id AS "scoreBandId",
        sb.assessment_version_id AS "scoreBandAssessmentVersionId",
        sb.label AS "scoreBandLabel",
        sb.min_score AS "scoreBandMinScore",
        sb.max_score AS "scoreBandMaxScore",
        sb.color_hex AS "scoreBandColorHex",
        sb.summary AS "scoreBandSummary",
        sb.recommendation_template AS "scoreBandRecommendationTemplate",
        sb.position AS "scoreBandPosition"
      FROM results r
      LEFT JOIN score_bands sb ON sb.id = r.score_band_id
      WHERE r.session_id = $1
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rows[0] ?? null;
}

export function createSessionsService(deps: ServiceDeps) {
  const { db, assessmentsRepository } = deps;

  async function getRuntimeOrThrow(slug: string, executor: QueryExecutor = db) {
    const runtime = await assessmentsRepository.getPublishedRuntimeBySlug(slug, executor);
    if (!runtime) {
      throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'Published assessment not found');
    }
    return runtime;
  }

  async function computeResponseScore(
    executor: QueryExecutor,
    question: QuestionScoreRow,
    answer: ResponseAnswer
  ): Promise<number> {
    const weight = toNumber(question.weight);

    if (question.type === 'single_choice') {
      if (typeof answer !== 'string') {
        throw new AppError(422, 'VALIDATION_ERROR', 'single_choice questions require a string answer');
      }

      const optionResult = await asExecutor(executor).query<{ scoreValue: string | number }>(
        `
          SELECT score_value AS "scoreValue"
          FROM answer_options
          WHERE question_id = $1
            AND value = $2
          LIMIT 1
        `,
        [question.id, answer]
      );
      const optionScore = optionResult.rows[0] ? toNumber(optionResult.rows[0].scoreValue) : 0;
      return optionScore * weight;
    }

    if (question.type === 'multi_choice') {
      const normalizedAnswer = normalizeAnswerForQuestion(question.type, answer);
      if (!Array.isArray(normalizedAnswer) || !normalizedAnswer.every((entry) => typeof entry === 'string')) {
        throw new AppError(422, 'VALIDATION_ERROR', 'multi_choice questions require an array of string answers');
      }

      const chosenValues = new Set(normalizedAnswer);
      const optionsResult = await asExecutor(executor).query<{ value: string; scoreValue: string | number }>(
        `
          SELECT value, score_value AS "scoreValue"
          FROM answer_options
          WHERE question_id = $1
        `,
        [question.id]
      );

      let total = 0;
      for (const option of optionsResult.rows) {
        if (chosenValues.has(option.value)) {
          total += toNumber(option.scoreValue);
        }
      }
      return total * weight;
    }

    if (question.type === 'numeric' || question.type === 'scale') {
      if (typeof answer !== 'number' || !Number.isFinite(answer)) {
        throw new AppError(422, 'VALIDATION_ERROR', 'numeric/scale questions require a numeric answer');
      }

      if (question.minValue !== null && answer < toNumber(question.minValue)) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Answer is below the minimum allowed value');
      }
      if (question.maxValue !== null && answer > toNumber(question.maxValue)) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Answer exceeds the maximum allowed value');
      }

      return answer * weight;
    }

    return 0;
  }

  return {
    async getPublicBootstrap(slug: string) {
      const runtime = await getRuntimeOrThrow(slug);

      const landing = await assessmentsRepository.ensureLandingPage(runtime.tenantId, runtime.assessmentVersionId);
      if (!landing) {
        throw new AppError(404, 'LANDING_PAGE_NOT_FOUND', 'Landing page not found');
      }
      const blocks = await assessmentsRepository.listPageBlocks(runtime.tenantId, runtime.assessmentVersionId);
      const questions = await assessmentsRepository.listQuestions(runtime.tenantId, runtime.assessmentVersionId);
      const questionsWithOptions = await Promise.all(
        questions.map(async (question) => ({
          ...question,
          options: await assessmentsRepository.listAnswerOptionsByQuestion(question.id)
        }))
      );
      const logicRules = await assessmentsRepository.listLogicRules(runtime.tenantId, runtime.assessmentVersionId);

      const response: {
        assessmentId: string;
        assessmentVersionId: string;
        landing: typeof landing;
        questions: typeof questionsWithOptions;
        logicRules: typeof logicRules;
        leadCaptureMode: 'start' | 'middle' | 'before_results';
        leadCaptureStep?: number;
      } = {
        assessmentId: runtime.assessmentId,
        assessmentVersionId: runtime.assessmentVersionId,
        landing: {
          ...landing,
          blocks
        },
        questions: questionsWithOptions,
        logicRules,
        leadCaptureMode: runtime.leadCaptureMode
      };
      if (typeof runtime.leadCaptureStep === 'number') {
        response.leadCaptureStep = runtime.leadCaptureStep;
      }

      return response;
    },

    async startPublicSession(input: {
      slug: string;
      utm?: Record<string, string>;
      ipAddress: string;
      userAgent?: string;
    }) {
      const runtime = await getRuntimeOrThrow(input.slug);

      const firstQuestionResult = await db.query<{ position: number }>(
        `
          SELECT position
          FROM questions
          WHERE assessment_version_id = $1
          ORDER BY position ASC
          LIMIT 1
        `,
        [runtime.assessmentVersionId]
      );
      const firstQuestionPosition = firstQuestionResult.rows[0]?.position ?? null;

      const runtimeContext = {
        utm: input.utm ?? {}
      };

      const created = await db.query<SessionRow>(
        `
          INSERT INTO sessions (
            assessment_id,
            assessment_version_id,
            status,
            current_question_position,
            runtime_context,
            ip_address,
            user_agent
          )
          VALUES ($1, $2, 'in_progress', $3, $4::jsonb, $5, $6)
          RETURNING
            id,
            assessment_id AS "assessmentId",
            assessment_version_id AS "assessmentVersionId",
            lead_id AS "leadId",
            status::text AS status,
            current_question_position AS "currentQuestionPosition",
            started_at AS "startedAt",
            completed_at AS "completedAt"
        `,
        [
          runtime.assessmentId,
          runtime.assessmentVersionId,
          firstQuestionPosition,
          JSON.stringify(runtimeContext),
          input.ipAddress,
          input.userAgent ?? null
        ]
      );

      const session = created.rows[0];
      if (!session) {
        throw new AppError(500, 'SESSION_CREATE_FAILED', 'Unable to start session');
      }

      await recordAuditLog(db, {
        tenantId: runtime.tenantId,
        action: 'session.start',
        targetType: 'session',
        targetId: session.id,
        metadata: {
          assessmentId: runtime.assessmentId,
          assessmentVersionId: runtime.assessmentVersionId
        }
      });

      return mapSession(session);
    },

    async upsertLead(input: {
      sessionId: string;
      email: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      company?: string;
      customFields?: JsonObject;
      consent: boolean;
    }) {
      return db.withTransaction(async (client) => {
        const session = await getSessionContext(input.sessionId, client);
        if (!session) {
          throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
        }

        const consentAt = input.consent ? new Date().toISOString() : null;
        const customFields = JSON.stringify(input.customFields ?? {});
        const runtimeContext = asObject(session.runtimeContext);
        const sourceUtm = JSON.stringify(asObject(runtimeContext.utm));

        let leadRow: LeadRow | null = null;
        let createdLead = false;

        if (session.leadId) {
          const updatedLead = await asExecutor(client).query<LeadRow>(
            `
              UPDATE leads
              SET email = $2,
                  first_name = $3,
                  last_name = $4,
                  phone = $5,
                  company = $6,
                  custom_fields = $7::jsonb,
                  consent = $8,
                  consent_at = $9,
                  updated_at = now()
              WHERE id = $1
              RETURNING
                id,
                tenant_id AS "tenantId",
                assessment_id AS "assessmentId",
                email,
                first_name AS "firstName",
                last_name AS "lastName",
                phone,
                company,
                custom_fields AS "customFields",
                consent,
                consent_at AS "consentAt",
                created_at AS "createdAt"
            `,
            [
              session.leadId,
              input.email,
              input.firstName ?? null,
              input.lastName ?? null,
              input.phone ?? null,
              input.company ?? null,
              customFields,
              input.consent,
              consentAt
            ]
          );
          leadRow = updatedLead.rows[0] ?? null;
        } else {
          const insertedLead = await asExecutor(client).query<LeadRow>(
            `
              INSERT INTO leads (
                tenant_id,
                assessment_id,
                email,
                first_name,
                last_name,
                phone,
                company,
                custom_fields,
                consent,
                consent_at,
                source_utm
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)
              RETURNING
                id,
                tenant_id AS "tenantId",
                assessment_id AS "assessmentId",
                email,
                first_name AS "firstName",
                last_name AS "lastName",
                phone,
                company,
                custom_fields AS "customFields",
                consent,
                consent_at AS "consentAt",
                created_at AS "createdAt"
            `,
            [
              session.tenantId,
              session.assessmentId,
              input.email,
              input.firstName ?? null,
              input.lastName ?? null,
              input.phone ?? null,
              input.company ?? null,
              customFields,
              input.consent,
              consentAt,
              sourceUtm
            ]
          );

          leadRow = insertedLead.rows[0] ?? null;
          if (leadRow) {
            createdLead = true;
            await asExecutor(client).query(
              `
                UPDATE sessions
                SET lead_id = $2, updated_at = now()
                WHERE id = $1
              `,
              [session.sessionId, leadRow.id]
            );
          }
        }

        if (!leadRow) {
          throw new AppError(500, 'LEAD_UPSERT_FAILED', 'Unable to upsert lead');
        }

        await recordAuditLog(client, {
          tenantId: session.tenantId,
          action: 'session.lead_upsert',
          targetType: 'lead',
          targetId: leadRow.id,
          metadata: {
            sessionId: session.sessionId
          }
        });

        if (createdLead) {
          await enqueueWebhookEvent(client, {
            tenantId: session.tenantId,
            eventType: 'lead.created',
            dedupeKey: `lead.created:${leadRow.id}`,
            payload: {
              leadId: leadRow.id,
              sessionId: session.sessionId,
              assessmentId: session.assessmentId,
              email: leadRow.email
            }
          });
        }

        return mapLead(leadRow);
      });
    },

    async upsertResponse(input: {
      sessionId: string;
      questionId: string;
      answer: ResponseAnswer;
    }) {
      return db.withTransaction(async (client) => {
        const session = await getSessionContext(input.sessionId, client);
        if (!session) {
          throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
        }
        if (session.status === 'completed') {
          throw new AppError(409, 'SESSION_COMPLETED', 'Session is already completed');
        }

        const questionResult = await asExecutor(client).query<QuestionScoreRow>(
          `
            SELECT
              id,
              type::text AS type,
              position,
              weight,
              min_value AS "minValue",
              max_value AS "maxValue"
            FROM questions
            WHERE id = $1
              AND assessment_version_id = $2
            LIMIT 1
          `,
          [input.questionId, session.assessmentVersionId]
        );
        const question = questionResult.rows[0];
        if (!question) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Question does not belong to this assessment version');
        }

        const normalizedAnswer = normalizeAnswerForQuestion(question.type, input.answer);
        const computedScore = await computeResponseScore(client, question, normalizedAnswer);

        const responseResult = await asExecutor(client).query<ResponseRow>(
          `
            INSERT INTO responses (
              session_id,
              question_id,
              answer_json,
              computed_score,
              answered_at
            )
            VALUES ($1, $2, $3::jsonb, $4, now())
            ON CONFLICT (session_id, question_id)
            DO UPDATE SET
              answer_json = EXCLUDED.answer_json,
              computed_score = EXCLUDED.computed_score,
              answered_at = now(),
              updated_at = now()
            RETURNING
              id,
              session_id AS "sessionId",
              question_id AS "questionId",
              answer_json AS answer,
              computed_score AS "computedScore",
              answered_at AS "answeredAt"
          `,
          [session.sessionId, question.id, JSON.stringify(normalizedAnswer), computedScore]
        );
        const response = responseResult.rows[0];
        if (!response) {
          throw new AppError(500, 'RESPONSE_UPSERT_FAILED', 'Unable to upsert response');
        }

        const nextPositionResult = await asExecutor(client).query<{ nextPosition: number | null }>(
          `
            SELECT MIN(q.position) AS "nextPosition"
            FROM questions q
            LEFT JOIN responses r
              ON r.question_id = q.id
             AND r.session_id = $2
            WHERE q.assessment_version_id = $1
              AND r.id IS NULL
          `,
          [session.assessmentVersionId, session.sessionId]
        );
        const nextPosition = nextPositionResult.rows[0]?.nextPosition ?? null;
        await asExecutor(client).query(
          `
            UPDATE sessions
            SET current_question_position = $2,
                updated_at = now()
            WHERE id = $1
          `,
          [session.sessionId, nextPosition]
        );

        await recordAuditLog(client, {
          tenantId: session.tenantId,
          action: 'session.response_upsert',
          targetType: 'response',
          targetId: response.id,
          metadata: {
            sessionId: session.sessionId,
            questionId: question.id
          }
        });

        return mapResponse(response);
      });
    },

    async completeSession(sessionId: string) {
      return db.withTransaction(async (client) => {
        const session = await getSessionContext(sessionId, client);
        if (!session) {
          throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
        }

        if (session.status === 'completed') {
          const existing = await getResultBySession(sessionId, client);
          if (!existing) {
            throw new AppError(409, 'SESSION_ALREADY_COMPLETED', 'Session is already completed');
          }
          return mapResult(existing);
        }
        if (session.status === 'abandoned') {
          throw new AppError(409, 'SESSION_ABANDONED', 'Abandoned session cannot be completed');
        }

        const rawScoreResult = await asExecutor(client).query<{ rawScore: string | number }>(
          `
            SELECT COALESCE(SUM(computed_score), 0) AS "rawScore"
            FROM responses
            WHERE session_id = $1
          `,
          [sessionId]
        );
        const rawScore = rawScoreResult.rows[0] ? toNumber(rawScoreResult.rows[0].rawScore) : 0;

        const maxScoreResult = await asExecutor(client).query<{ maxPossibleRawScore: string | number }>(
          `
            WITH option_max AS (
              SELECT
                question_id,
                MAX(score_value) AS max_option_score
              FROM answer_options
              GROUP BY question_id
            )
            SELECT COALESCE(
              SUM(
                CASE
                  WHEN q.type::text IN ('single_choice', 'multi_choice') THEN
                    q.weight * COALESCE(om.max_option_score, 0)
                  WHEN q.type::text IN ('numeric', 'scale') THEN
                    q.weight * COALESCE(q.max_value, 0)
                  ELSE 0
                END
              ),
              0
            ) AS "maxPossibleRawScore"
            FROM questions q
            LEFT JOIN option_max om ON om.question_id = q.id
            WHERE q.assessment_version_id = $1
          `,
          [session.assessmentVersionId]
        );
        const maxPossibleRawScore = maxScoreResult.rows[0] ? toNumber(maxScoreResult.rows[0].maxPossibleRawScore) : 0;
        const normalizedScore = maxPossibleRawScore > 0 ? Number(((rawScore / maxPossibleRawScore) * 100).toFixed(2)) : 0;

        const scoreBandResult = await asExecutor(client).query<{
          id: string;
          recommendationTemplate: string | null;
        }>(
          `
            SELECT
              id,
              recommendation_template AS "recommendationTemplate"
            FROM score_bands
            WHERE assessment_version_id = $1
              AND min_score <= $2
              AND max_score >= $2
            ORDER BY position ASC
            LIMIT 1
          `,
          [session.assessmentVersionId, normalizedScore]
        );
        const scoreBand = scoreBandResult.rows[0] ?? null;

        const breakdownResult = await asExecutor(client).query<{
          questionId: string;
          computedScore: string | number;
        }>(
          `
            SELECT
              question_id AS "questionId",
              computed_score AS "computedScore"
            FROM responses
            WHERE session_id = $1
            ORDER BY answered_at ASC
          `,
          [sessionId]
        );

        const breakdown = {
          questionScores: breakdownResult.rows.map((row) => ({
            questionId: row.questionId,
            computedScore: toNumber(row.computedScore)
          }))
        };
        const recommendations = scoreBand?.recommendationTemplate ? [scoreBand.recommendationTemplate] : [];

        await asExecutor(client).query(
          `
            INSERT INTO results (
              session_id,
              score_band_id,
              raw_score,
              normalized_score,
              max_possible_raw_score,
              breakdown,
              recommendations,
              generated_report,
              finalized_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now())
            ON CONFLICT (session_id)
            DO UPDATE SET
              score_band_id = EXCLUDED.score_band_id,
              raw_score = EXCLUDED.raw_score,
              normalized_score = EXCLUDED.normalized_score,
              max_possible_raw_score = EXCLUDED.max_possible_raw_score,
              breakdown = EXCLUDED.breakdown,
              recommendations = EXCLUDED.recommendations,
              generated_report = EXCLUDED.generated_report,
              finalized_at = now(),
              updated_at = now()
          `,
          [
            sessionId,
            scoreBand?.id ?? null,
            rawScore,
            normalizedScore,
            maxPossibleRawScore,
            JSON.stringify(breakdown),
            JSON.stringify(recommendations),
            JSON.stringify({})
          ]
        );

        await asExecutor(client).query(
          `
            UPDATE sessions
            SET status = 'completed',
                completed_at = COALESCE(completed_at, now()),
                current_question_position = NULL,
                updated_at = now()
            WHERE id = $1
          `,
          [sessionId]
        );

        const finalized = await getResultBySession(sessionId, client);
        if (!finalized) {
          throw new AppError(500, 'RESULT_NOT_FOUND', 'Result not found after completion');
        }

        await recordAuditLog(client, {
          tenantId: session.tenantId,
          action: 'session.complete',
          targetType: 'session',
          targetId: sessionId,
          metadata: {
            rawScore,
            normalizedScore
          }
        });

        await enqueueWebhookEvent(client, {
          tenantId: session.tenantId,
          eventType: 'session.completed',
          dedupeKey: `session.completed:${sessionId}`,
          payload: {
            sessionId,
            assessmentId: session.assessmentId,
            normalizedScore
          }
        });

        return mapResult(finalized);
      });
    },

    async getSessionResult(sessionId: string) {
      const result = await getResultBySession(sessionId, db);
      if (!result) {
        throw new AppError(404, 'RESULT_NOT_FOUND', 'Result not found');
      }
      return mapResult(result);
    },

    async queuePdfJob(input: { sessionId: string; emailTo?: string }) {
      const session = await getSessionContext(input.sessionId, db);
      if (!session) {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
      }

      const created = await db.query<PdfJobRow>(
        `
          INSERT INTO pdf_jobs (session_id, status, requested_by_email)
          VALUES ($1, 'queued', $2)
          RETURNING
            id,
            session_id AS "sessionId",
            status::text AS status,
            storage_key AS "storageKey",
            file_url AS "fileUrl",
            error_message AS "errorMessage",
            attempt_count AS "attemptCount",
            queued_at AS "queuedAt",
            started_at AS "startedAt",
            completed_at AS "completedAt"
        `,
        [input.sessionId, input.emailTo ?? null]
      );
      const job = created.rows[0];
      if (!job) {
        throw new AppError(500, 'PDF_JOB_QUEUE_FAILED', 'Unable to queue PDF job');
      }

      await recordAuditLog(db, {
        tenantId: session.tenantId,
        action: 'pdf_job.queue',
        targetType: 'pdf_job',
        targetId: job.id,
        metadata: {
          sessionId: input.sessionId
        }
      });

      return mapPdfJob(job);
    },

    async getPdfJob(jobId: string) {
      const result = await db.query<PdfJobRow>(
        `
          SELECT
            id,
            session_id AS "sessionId",
            status::text AS status,
            storage_key AS "storageKey",
            file_url AS "fileUrl",
            error_message AS "errorMessage",
            attempt_count AS "attemptCount",
            queued_at AS "queuedAt",
            started_at AS "startedAt",
            completed_at AS "completedAt"
          FROM pdf_jobs
          WHERE id = $1
          LIMIT 1
        `,
        [jobId]
      );

      const row = result.rows[0];
      if (!row) {
        throw new AppError(404, 'PDF_JOB_NOT_FOUND', 'PDF job not found');
      }

      return mapPdfJob(row);
    }
  };
}

export type SessionsService = ReturnType<typeof createSessionsService>;
