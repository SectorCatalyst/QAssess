import type { PoolClient, QueryResultRow } from 'pg';

import type { DatabaseClient } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';

type QueryExecutor = DatabaseClient | PoolClient;

interface ServiceDeps {
  db: DatabaseClient;
}

interface AssessmentRow {
  id: string;
}

interface SummaryStatsRow {
  starts: string | number;
  completions: string | number;
  leads: string | number;
  averageScore: string | number | null;
}

interface VisitsRow {
  visits: string | number;
}

interface DropoffRow {
  questionId: string;
  questionPrompt: string;
  views: string | number;
  exits: string | number;
}

function asExecutor(executor: QueryExecutor): {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
} {
  return executor as unknown as {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  };
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toDateOnly(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function resolveDateRange(input: { dateFrom?: string; dateTo?: string }): { dateFrom: string; dateTo: string } {
  const today = new Date();

  const dateTo = input.dateTo ? new Date(`${input.dateTo}T00:00:00.000Z`) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (Number.isNaN(dateTo.valueOf())) {
    throw new AppError(422, 'VALIDATION_ERROR', 'dateTo must be a valid ISO date');
  }

  const defaultDateFrom = new Date(dateTo);
  defaultDateFrom.setUTCDate(defaultDateFrom.getUTCDate() - 29);

  const dateFrom = input.dateFrom ? new Date(`${input.dateFrom}T00:00:00.000Z`) : defaultDateFrom;
  if (Number.isNaN(dateFrom.valueOf())) {
    throw new AppError(422, 'VALIDATION_ERROR', 'dateFrom must be a valid ISO date');
  }
  if (dateFrom > dateTo) {
    throw new AppError(422, 'VALIDATION_ERROR', 'dateFrom must be before or equal to dateTo');
  }

  return {
    dateFrom: toDateOnly(dateFrom),
    dateTo: toDateOnly(dateTo)
  };
}

async function assertAssessmentInTenant(tenantId: string, assessmentId: string, executor: QueryExecutor): Promise<void> {
  const result = await asExecutor(executor).query<AssessmentRow>(
    `
      SELECT id
      FROM assessments
      WHERE id = $1
        AND tenant_id = $2
      LIMIT 1
    `,
    [assessmentId, tenantId]
  );

  if (!result.rows[0]) {
    throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'Assessment not found');
  }
}

export function createAnalyticsService(deps: ServiceDeps) {
  const { db } = deps;

  return {
    async getAssessmentSummary(input: {
      tenantId: string;
      assessmentId: string;
      dateFrom?: string;
      dateTo?: string;
    }) {
      const range = resolveDateRange(input);

      await assertAssessmentInTenant(input.tenantId, input.assessmentId, db);

      const statsResult = await db.query<SummaryStatsRow>(
        `
          SELECT
            COUNT(*) AS starts,
            SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completions,
            COUNT(DISTINCT s.lead_id) AS leads,
            AVG(r.normalized_score) AS "averageScore"
          FROM sessions s
          LEFT JOIN results r ON r.session_id = s.id
          WHERE s.assessment_id = $1
            AND s.started_at::date BETWEEN $2::date AND $3::date
        `,
        [input.assessmentId, range.dateFrom, range.dateTo]
      );

      const visitsResult = await db.query<VisitsRow>(
        `
          SELECT COALESCE(SUM(visits), 0) AS visits
          FROM analytics_daily_assessment
          WHERE tenant_id = $1
            AND assessment_id = $2
            AND date_key BETWEEN $3::date AND $4::date
        `,
        [input.tenantId, input.assessmentId, range.dateFrom, range.dateTo]
      );

      const row = statsResult.rows[0];
      const starts = row ? toNumber(row.starts) : 0;
      const completions = row ? toNumber(row.completions) : 0;
      const leads = row ? toNumber(row.leads) : 0;
      const summary: {
        assessmentId: string;
        dateFrom: string;
        dateTo: string;
        visits: number;
        starts: number;
        completions: number;
        leads: number;
        conversionRate: number;
        averageScore?: number;
      } = {
        assessmentId: input.assessmentId,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        visits: Math.max(starts, toNumber(visitsResult.rows[0]?.visits ?? 0)),
        starts,
        completions,
        leads,
        conversionRate: starts > 0 ? Number((completions / starts).toFixed(4)) : 0
      };

      if (row?.averageScore !== null && row?.averageScore !== undefined) {
        summary.averageScore = Number(toNumber(row.averageScore).toFixed(2));
      }

      return summary;
    },

    async getAssessmentDropoff(input: {
      tenantId: string;
      assessmentId: string;
      dateFrom?: string;
      dateTo?: string;
    }) {
      const range = resolveDateRange(input);

      await assertAssessmentInTenant(input.tenantId, input.assessmentId, db);

      const dropoffResult = await db.query<DropoffRow>(
        `
          WITH scoped_sessions AS (
            SELECT id, status
            FROM sessions
            WHERE assessment_id = $1
              AND started_at::date BETWEEN $2::date AND $3::date
          ),
          session_last_answer AS (
            SELECT
              r.session_id AS "sessionId",
              MAX(r.answered_at) AS "lastAnsweredAt"
            FROM responses r
            JOIN scoped_sessions ss ON ss.id = r.session_id
            GROUP BY r.session_id
          ),
          last_answers AS (
            SELECT
              r.session_id AS "sessionId",
              r.question_id AS "questionId"
            FROM responses r
            JOIN session_last_answer sla
              ON sla."sessionId" = r.session_id
             AND sla."lastAnsweredAt" = r.answered_at
          ),
          views AS (
            SELECT
              r.question_id AS "questionId",
              COUNT(*) AS views
            FROM responses r
            JOIN scoped_sessions ss ON ss.id = r.session_id
            GROUP BY r.question_id
          ),
          exits AS (
            SELECT
              la."questionId",
              COUNT(*) AS exits
            FROM last_answers la
            JOIN scoped_sessions ss ON ss.id = la."sessionId"
            WHERE ss.status <> 'completed'
            GROUP BY la."questionId"
          )
          SELECT
            q.id AS "questionId",
            q.prompt AS "questionPrompt",
            COALESCE(v.views, 0) AS views,
            COALESCE(e.exits, 0) AS exits
          FROM questions q
          JOIN assessment_versions av ON av.id = q.assessment_version_id
          LEFT JOIN views v ON v."questionId" = q.id
          LEFT JOIN exits e ON e."questionId" = q.id
          WHERE av.assessment_id = $1
          ORDER BY q.position ASC
        `,
        [input.assessmentId, range.dateFrom, range.dateTo]
      );

      return dropoffResult.rows.map((row) => {
        const views = toNumber(row.views);
        const exits = toNumber(row.exits);
        return {
          questionId: row.questionId,
          questionPrompt: row.questionPrompt,
          views,
          exits,
          dropoffRate: views > 0 ? Number((exits / views).toFixed(4)) : 0
        };
      });
    }
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
