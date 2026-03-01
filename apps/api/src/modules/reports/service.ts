import type { PoolClient, QueryResultRow } from 'pg';

import { recordAuditLog } from '../../lib/audit.js';
import type { DatabaseClient } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';

type QueryExecutor = DatabaseClient | PoolClient;
type JsonObject = Record<string, unknown>;

interface ServiceDeps {
  db: DatabaseClient;
}

interface VersionContextRow {
  assessmentId: string;
  assessmentVersionId: string;
  tenantId: string;
  versionTitle: string;
  isPublished: boolean;
}

interface TemplateContextRow {
  templateId: string;
  assessmentVersionId: string;
  tenantId: string;
  isPublished: boolean;
}

interface SectionContextRow {
  sectionId: string;
  templateId: string;
  assessmentVersionId: string;
  tenantId: string;
  isPublished: boolean;
}

interface ReportTemplateRow {
  id: string;
  assessmentVersionId: string;
  title: string;
  headerContent: unknown;
  footerContent: unknown;
}

interface ReportSectionRow {
  id: string;
  reportTemplateId: string;
  sectionKey: string;
  title: string;
  bodyTemplate: string;
  displayCondition: unknown;
  position: number;
}

function asExecutor(executor: QueryExecutor): {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
} {
  return executor as unknown as {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  };
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function mapSection(row: ReportSectionRow): {
  id: string;
  reportTemplateId: string;
  sectionKey: string;
  title: string;
  bodyTemplate: string;
  displayCondition: JsonObject;
  position: number;
} {
  return {
    id: row.id,
    reportTemplateId: row.reportTemplateId,
    sectionKey: row.sectionKey,
    title: row.title,
    bodyTemplate: row.bodyTemplate,
    displayCondition: asObject(row.displayCondition),
    position: row.position
  };
}

function mapTemplate(
  row: ReportTemplateRow,
  sections: ReportSectionRow[]
): {
  id: string;
  assessmentVersionId: string;
  title: string;
  headerContent: JsonObject;
  footerContent: JsonObject;
  sections: Array<{
    id: string;
    reportTemplateId: string;
    sectionKey: string;
    title: string;
    bodyTemplate: string;
    displayCondition: JsonObject;
    position: number;
  }>;
} {
  return {
    id: row.id,
    assessmentVersionId: row.assessmentVersionId,
    title: row.title,
    headerContent: asObject(row.headerContent),
    footerContent: asObject(row.footerContent),
    sections: sections.map((entry) => mapSection(entry))
  };
}

async function getVersionContext(
  tenantId: string,
  versionId: string,
  executor: QueryExecutor
): Promise<VersionContextRow | null> {
  const result = await asExecutor(executor).query<VersionContextRow>(
    `
      SELECT
        a.id AS "assessmentId",
        av.id AS "assessmentVersionId",
        a.tenant_id AS "tenantId",
        av.title AS "versionTitle",
        av.is_published AS "isPublished"
      FROM assessment_versions av
      JOIN assessments a ON a.id = av.assessment_id
      WHERE av.id = $1
        AND a.tenant_id = $2
      LIMIT 1
    `,
    [versionId, tenantId]
  );

  return result.rows[0] ?? null;
}

async function getTemplateContext(
  tenantId: string,
  templateId: string,
  executor: QueryExecutor
): Promise<TemplateContextRow | null> {
  const result = await asExecutor(executor).query<TemplateContextRow>(
    `
      SELECT
        rt.id AS "templateId",
        rt.assessment_version_id AS "assessmentVersionId",
        a.tenant_id AS "tenantId",
        av.is_published AS "isPublished"
      FROM report_templates rt
      JOIN assessment_versions av ON av.id = rt.assessment_version_id
      JOIN assessments a ON a.id = av.assessment_id
      WHERE rt.id = $1
        AND a.tenant_id = $2
      LIMIT 1
    `,
    [templateId, tenantId]
  );

  return result.rows[0] ?? null;
}

async function getSectionContext(
  tenantId: string,
  sectionId: string,
  executor: QueryExecutor
): Promise<SectionContextRow | null> {
  const result = await asExecutor(executor).query<SectionContextRow>(
    `
      SELECT
        rs.id AS "sectionId",
        rs.report_template_id AS "templateId",
        rt.assessment_version_id AS "assessmentVersionId",
        a.tenant_id AS "tenantId",
        av.is_published AS "isPublished"
      FROM report_sections rs
      JOIN report_templates rt ON rt.id = rs.report_template_id
      JOIN assessment_versions av ON av.id = rt.assessment_version_id
      JOIN assessments a ON a.id = av.assessment_id
      WHERE rs.id = $1
        AND a.tenant_id = $2
      LIMIT 1
    `,
    [sectionId, tenantId]
  );

  return result.rows[0] ?? null;
}

async function listSections(templateId: string, executor: QueryExecutor): Promise<ReportSectionRow[]> {
  const result = await asExecutor(executor).query<ReportSectionRow>(
    `
      SELECT
        id,
        report_template_id AS "reportTemplateId",
        section_key AS "sectionKey",
        title,
        body_template AS "bodyTemplate",
        display_condition AS "displayCondition",
        position
      FROM report_sections
      WHERE report_template_id = $1
      ORDER BY position ASC
    `,
    [templateId]
  );

  return result.rows;
}

async function getTemplateRowByVersion(versionId: string, executor: QueryExecutor): Promise<ReportTemplateRow | null> {
  const result = await asExecutor(executor).query<ReportTemplateRow>(
    `
      SELECT
        id,
        assessment_version_id AS "assessmentVersionId",
        title,
        header_content AS "headerContent",
        footer_content AS "footerContent"
      FROM report_templates
      WHERE assessment_version_id = $1
      LIMIT 1
    `,
    [versionId]
  );

  return result.rows[0] ?? null;
}

function assertMutable(isPublished: boolean): void {
  if (isPublished) {
    throw new AppError(409, 'VERSION_PUBLISHED', 'Published versions are immutable');
  }
}

export function createReportsService(deps: ServiceDeps) {
  const { db } = deps;

  return {
    async getReportTemplate(tenantId: string, versionId: string) {
      return db.withTransaction(async (client) => {
        const context = await getVersionContext(tenantId, versionId, client);
        if (!context) {
          throw new AppError(404, 'VERSION_NOT_FOUND', 'Assessment version not found');
        }

        let template = await getTemplateRowByVersion(versionId, client);
        if (!template) {
          const created = await asExecutor(client).query<ReportTemplateRow>(
            `
              INSERT INTO report_templates (
                assessment_version_id,
                title,
                header_content,
                footer_content
              )
              VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb)
              RETURNING
                id,
                assessment_version_id AS "assessmentVersionId",
                title,
                header_content AS "headerContent",
                footer_content AS "footerContent"
            `,
            [versionId, `${context.versionTitle} Report`]
          );
          template = created.rows[0] ?? null;
        }

        if (!template) {
          throw new AppError(500, 'REPORT_TEMPLATE_INIT_FAILED', 'Unable to initialize report template');
        }

        const sections = await listSections(template.id, client);
        return mapTemplate(template, sections);
      });
    },

    async upsertReportTemplate(input: {
      tenantId: string;
      versionId: string;
      actorUserId: string;
      title: string;
      headerContent?: JsonObject;
      footerContent?: JsonObject;
    }) {
      return db.withTransaction(async (client) => {
        const context = await getVersionContext(input.tenantId, input.versionId, client);
        if (!context) {
          throw new AppError(404, 'VERSION_NOT_FOUND', 'Assessment version not found');
        }
        assertMutable(context.isPublished);

        const templateResult = await asExecutor(client).query<ReportTemplateRow>(
          `
            INSERT INTO report_templates (
              assessment_version_id,
              title,
              header_content,
              footer_content
            )
            VALUES ($1, $2, $3::jsonb, $4::jsonb)
            ON CONFLICT (assessment_version_id)
            DO UPDATE SET
              title = EXCLUDED.title,
              header_content = EXCLUDED.header_content,
              footer_content = EXCLUDED.footer_content,
              updated_at = now()
            RETURNING
              id,
              assessment_version_id AS "assessmentVersionId",
              title,
              header_content AS "headerContent",
              footer_content AS "footerContent"
          `,
          [
            input.versionId,
            input.title,
            JSON.stringify(input.headerContent ?? {}),
            JSON.stringify(input.footerContent ?? {})
          ]
        );
        const template = templateResult.rows[0];
        if (!template) {
          throw new AppError(500, 'REPORT_TEMPLATE_UPSERT_FAILED', 'Unable to upsert report template');
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'report_template.upsert',
          targetType: 'report_template',
          targetId: template.id,
          metadata: {
            assessmentVersionId: input.versionId
          }
        });

        const sections = await listSections(template.id, client);
        return mapTemplate(template, sections);
      });
    },

    async createReportSection(input: {
      tenantId: string;
      templateId: string;
      actorUserId: string;
      sectionKey: string;
      title: string;
      bodyTemplate: string;
      displayCondition?: JsonObject;
      position: number;
    }) {
      return db.withTransaction(async (client) => {
        const context = await getTemplateContext(input.tenantId, input.templateId, client);
        if (!context) {
          throw new AppError(404, 'REPORT_TEMPLATE_NOT_FOUND', 'Report template not found');
        }
        assertMutable(context.isPublished);

        const sectionResult = await asExecutor(client).query<ReportSectionRow>(
          `
            INSERT INTO report_sections (
              report_template_id,
              section_key,
              title,
              body_template,
              display_condition,
              position
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            RETURNING
              id,
              report_template_id AS "reportTemplateId",
              section_key AS "sectionKey",
              title,
              body_template AS "bodyTemplate",
              display_condition AS "displayCondition",
              position
          `,
          [
            input.templateId,
            input.sectionKey,
            input.title,
            input.bodyTemplate,
            JSON.stringify(input.displayCondition ?? {}),
            input.position
          ]
        );
        const section = sectionResult.rows[0];
        if (!section) {
          throw new AppError(500, 'REPORT_SECTION_CREATE_FAILED', 'Unable to create report section');
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'report_section.create',
          targetType: 'report_section',
          targetId: section.id,
          metadata: {
            reportTemplateId: input.templateId
          }
        });

        return mapSection(section);
      });
    },

    async updateReportSection(input: {
      tenantId: string;
      sectionId: string;
      actorUserId: string;
      patch: Partial<{
        title: string;
        bodyTemplate: string;
        displayCondition: JsonObject;
        position: number;
      }>;
    }) {
      return db.withTransaction(async (client) => {
        const context = await getSectionContext(input.tenantId, input.sectionId, client);
        if (!context) {
          throw new AppError(404, 'REPORT_SECTION_NOT_FOUND', 'Report section not found');
        }
        assertMutable(context.isPublished);

        const sectionResult = await asExecutor(client).query<ReportSectionRow>(
          `
            UPDATE report_sections
            SET
              title = CASE WHEN $2 THEN $3 ELSE title END,
              body_template = CASE WHEN $4 THEN $5 ELSE body_template END,
              display_condition = CASE WHEN $6 THEN $7::jsonb ELSE display_condition END,
              position = CASE WHEN $8 THEN $9 ELSE position END,
              updated_at = now()
            WHERE id = $1
            RETURNING
              id,
              report_template_id AS "reportTemplateId",
              section_key AS "sectionKey",
              title,
              body_template AS "bodyTemplate",
              display_condition AS "displayCondition",
              position
          `,
          [
            input.sectionId,
            typeof input.patch.title === 'string',
            input.patch.title ?? null,
            typeof input.patch.bodyTemplate === 'string',
            input.patch.bodyTemplate ?? null,
            input.patch.displayCondition !== undefined,
            JSON.stringify(input.patch.displayCondition ?? {}),
            typeof input.patch.position === 'number',
            input.patch.position ?? null
          ]
        );
        const section = sectionResult.rows[0];
        if (!section) {
          throw new AppError(500, 'REPORT_SECTION_UPDATE_FAILED', 'Unable to update report section');
        }

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'report_section.update',
          targetType: 'report_section',
          targetId: section.id,
          metadata: {
            reportTemplateId: context.templateId
          }
        });

        return mapSection(section);
      });
    },

    async deleteReportSection(input: {
      tenantId: string;
      sectionId: string;
      actorUserId: string;
    }) {
      return db.withTransaction(async (client) => {
        const context = await getSectionContext(input.tenantId, input.sectionId, client);
        if (!context) {
          throw new AppError(404, 'REPORT_SECTION_NOT_FOUND', 'Report section not found');
        }
        assertMutable(context.isPublished);

        await asExecutor(client).query(
          `
            DELETE FROM report_sections
            WHERE id = $1
          `,
          [input.sectionId]
        );

        await recordAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'report_section.delete',
          targetType: 'report_section',
          targetId: input.sectionId,
          metadata: {
            reportTemplateId: context.templateId
          }
        });
      });
    }
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
