import type { PoolClient, QueryResult } from 'pg';

import type { DatabaseClient } from '../../lib/db.js';

type QueryExecutor = DatabaseClient | PoolClient;

export type AssessmentStatus = 'draft' | 'published' | 'archived';
export type QuestionType = 'single_choice' | 'multi_choice' | 'scale' | 'numeric' | 'short_text';

export interface AssessmentRecord {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: AssessmentStatus;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedRuntimeRecord {
  tenantId: string;
  assessmentId: string;
  assessmentVersionId: string;
  leadCaptureMode: 'start' | 'middle' | 'before_results';
  leadCaptureStep?: number;
}

export interface AssessmentVersionRecord {
  id: string;
  assessmentId: string;
  versionNo: number;
  isPublished: boolean;
  publishedAt?: string;
  title: string;
  introCopy?: string;
  outroCopy?: string;
  leadCaptureMode: 'start' | 'middle' | 'before_results';
  leadCaptureStep?: number;
  runtimeSettings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PageBlockRecord {
  id: string;
  type: string;
  position: number;
  config: Record<string, unknown>;
  isVisible: boolean;
}

export interface LandingPageRecord {
  id: string;
  assessmentVersionId: string;
  seoTitle?: string;
  seoDescription?: string;
  theme: Record<string, unknown>;
  blocks: PageBlockRecord[];
}

export interface PageBlockWithVersionRecord extends PageBlockRecord {
  landingPageId: string;
  assessmentVersionId: string;
}

export interface QuestionRecord {
  id: string;
  assessmentVersionId: string;
  type: QuestionType;
  prompt: string;
  helpText?: string;
  isRequired: boolean;
  position: number;
  weight: number;
  minValue?: number;
  maxValue?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerOptionRecord {
  id: string;
  questionId: string;
  label: string;
  value: string;
  scoreValue: number;
  position: number;
  metadata: Record<string, unknown>;
}

export interface LogicRuleRecord {
  id: string;
  assessmentVersionId: string;
  name: string;
  priority: number;
  ifExpression: Record<string, unknown>;
  thenAction: Record<string, unknown>;
  isActive: boolean;
}

interface RawAssessmentRow {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: AssessmentStatus;
  description: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface RawVersionRow {
  id: string;
  assessmentId: string;
  versionNo: number;
  isPublished: boolean;
  publishedAt: Date | string | null;
  title: string;
  introCopy: string | null;
  outroCopy: string | null;
  leadCaptureMode: 'start' | 'middle' | 'before_results';
  leadCaptureStep: number | null;
  runtimeSettings: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface RawPublishedRuntimeRow {
  tenantId: string;
  assessmentId: string;
  assessmentVersionId: string;
  leadCaptureMode: 'start' | 'middle' | 'before_results';
  leadCaptureStep: number | null;
}

interface RawQuestionRow {
  id: string;
  assessmentVersionId: string;
  type: QuestionType;
  prompt: string;
  helpText: string | null;
  isRequired: boolean;
  position: number;
  weight: string | number;
  minValue: string | number | null;
  maxValue: string | number | null;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface RawLandingPageRow {
  id: string;
  assessmentVersionId: string;
  seoTitle: string | null;
  seoDescription: string | null;
  theme: Record<string, unknown>;
}

interface RawPageBlockRow {
  id: string;
  type: string;
  position: number;
  config: Record<string, unknown>;
  isVisible: boolean;
}

interface RawPageBlockWithVersionRow extends RawPageBlockRow {
  landingPageId: string;
  assessmentVersionId: string;
}

interface RawOptionRow {
  id: string;
  questionId: string;
  label: string;
  value: string;
  scoreValue: string | number;
  position: number;
  metadata: Record<string, unknown>;
}

interface RawLogicRuleRow {
  id: string;
  assessmentVersionId: string;
  name: string;
  priority: number;
  ifExpression: Record<string, unknown>;
  thenAction: Record<string, unknown>;
  isActive: boolean;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapAssessment(row: RawAssessmentRow): AssessmentRecord {
  const mapped: AssessmentRecord = {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt)
  };

  if (row.description !== null) {
    mapped.description = row.description;
  }

  return mapped;
}

function mapVersion(row: RawVersionRow): AssessmentVersionRecord {
  const mapped: AssessmentVersionRecord = {
    id: row.id,
    assessmentId: row.assessmentId,
    versionNo: row.versionNo,
    isPublished: row.isPublished,
    title: row.title,
    leadCaptureMode: row.leadCaptureMode,
    runtimeSettings: row.runtimeSettings ?? {},
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt)
  };

  if (row.publishedAt !== null) {
    mapped.publishedAt = toIsoString(row.publishedAt);
  }
  if (row.introCopy !== null) {
    mapped.introCopy = row.introCopy;
  }
  if (row.outroCopy !== null) {
    mapped.outroCopy = row.outroCopy;
  }
  if (row.leadCaptureStep !== null) {
    mapped.leadCaptureStep = row.leadCaptureStep;
  }

  return mapped;
}

function mapPublishedRuntime(row: RawPublishedRuntimeRow): PublishedRuntimeRecord {
  const mapped: PublishedRuntimeRecord = {
    tenantId: row.tenantId,
    assessmentId: row.assessmentId,
    assessmentVersionId: row.assessmentVersionId,
    leadCaptureMode: row.leadCaptureMode
  };

  if (row.leadCaptureStep !== null) {
    mapped.leadCaptureStep = row.leadCaptureStep;
  }

  return mapped;
}

function mapQuestion(row: RawQuestionRow): QuestionRecord {
  const mapped: QuestionRecord = {
    id: row.id,
    assessmentVersionId: row.assessmentVersionId,
    type: row.type,
    prompt: row.prompt,
    isRequired: row.isRequired,
    position: row.position,
    weight: toNumber(row.weight),
    metadata: row.metadata ?? {},
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt)
  };

  if (row.helpText !== null) {
    mapped.helpText = row.helpText;
  }
  if (row.minValue !== null) {
    mapped.minValue = toNumber(row.minValue);
  }
  if (row.maxValue !== null) {
    mapped.maxValue = toNumber(row.maxValue);
  }

  return mapped;
}

function mapLandingPage(row: RawLandingPageRow, blocks: PageBlockRecord[] = []): LandingPageRecord {
  const mapped: LandingPageRecord = {
    id: row.id,
    assessmentVersionId: row.assessmentVersionId,
    theme: row.theme ?? {},
    blocks
  };

  if (row.seoTitle !== null) {
    mapped.seoTitle = row.seoTitle;
  }
  if (row.seoDescription !== null) {
    mapped.seoDescription = row.seoDescription;
  }

  return mapped;
}

function mapPageBlock(row: RawPageBlockRow): PageBlockRecord {
  return {
    id: row.id,
    type: row.type,
    position: row.position,
    config: row.config ?? {},
    isVisible: row.isVisible
  };
}

function mapPageBlockWithVersion(row: RawPageBlockWithVersionRow): PageBlockWithVersionRecord {
  return {
    id: row.id,
    type: row.type,
    position: row.position,
    config: row.config ?? {},
    isVisible: row.isVisible,
    landingPageId: row.landingPageId,
    assessmentVersionId: row.assessmentVersionId
  };
}

function mapOption(row: RawOptionRow): AnswerOptionRecord {
  return {
    id: row.id,
    questionId: row.questionId,
    label: row.label,
    value: row.value,
    scoreValue: toNumber(row.scoreValue),
    position: row.position,
    metadata: row.metadata ?? {}
  };
}

function mapLogicRule(row: RawLogicRuleRow): LogicRuleRecord {
  return {
    id: row.id,
    assessmentVersionId: row.assessmentVersionId,
    name: row.name,
    priority: row.priority,
    ifExpression: row.ifExpression ?? {},
    thenAction: row.thenAction ?? {},
    isActive: row.isActive
  };
}

function asExecutor(executor: QueryExecutor): { query: (sql: string, params?: unknown[]) => Promise<QueryResult> } {
  return executor as unknown as { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };
}

function hasProperty<T extends object, K extends string>(obj: T, key: K): obj is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function createAssessmentsRepository(db: DatabaseClient) {
  const baseAssessmentSelect = `
    SELECT
      a.id,
      a.tenant_id AS "tenantId",
      a.name,
      a.slug::text AS slug,
      a.status::text AS status,
      a.description,
      a.created_at AS "createdAt",
      a.updated_at AS "updatedAt"
    FROM assessments a
  `;

  const baseVersionSelect = `
    SELECT
      v.id,
      v.assessment_id AS "assessmentId",
      v.version_no AS "versionNo",
      v.is_published AS "isPublished",
      v.published_at AS "publishedAt",
      v.title,
      v.intro_copy AS "introCopy",
      v.outro_copy AS "outroCopy",
      v.lead_capture_mode AS "leadCaptureMode",
      v.lead_capture_step AS "leadCaptureStep",
      v.runtime_settings AS "runtimeSettings",
      v.created_at AS "createdAt",
      v.updated_at AS "updatedAt"
    FROM assessment_versions v
  `;

  const baseLandingSelect = `
    SELECT
      lp.id,
      lp.assessment_version_id AS "assessmentVersionId",
      lp.seo_title AS "seoTitle",
      lp.seo_description AS "seoDescription",
      lp.theme
    FROM landing_pages lp
  `;

  const basePageBlockSelect = `
    SELECT
      pb.id,
      pb.type,
      pb.position,
      pb.config,
      pb.is_visible AS "isVisible"
    FROM page_blocks pb
  `;

  const baseQuestionSelect = `
    SELECT
      q.id,
      q.assessment_version_id AS "assessmentVersionId",
      q.type::text AS type,
      q.prompt,
      q.help_text AS "helpText",
      q.is_required AS "isRequired",
      q.position,
      q.weight,
      q.min_value AS "minValue",
      q.max_value AS "maxValue",
      q.metadata,
      q.created_at AS "createdAt",
      q.updated_at AS "updatedAt"
    FROM questions q
  `;

  return {
    async listAssessments(
      tenantId: string,
      options: {
        status?: AssessmentStatus | undefined;
        cursorCreatedAt?: string | undefined;
        cursorId?: string | undefined;
        limit: number;
      },
      executor: QueryExecutor = db
    ): Promise<AssessmentRecord[]> {
      const params: unknown[] = [tenantId];
      const conditions = ['a.tenant_id = $1'];

      if (options.status) {
        params.push(options.status);
        conditions.push(`a.status = $${params.length}::assessment_status`);
      }

      if (options.cursorCreatedAt && options.cursorId) {
        params.push(options.cursorCreatedAt, options.cursorId);
        conditions.push(`(a.created_at < $${params.length - 1}::timestamptz OR (a.created_at = $${params.length - 1}::timestamptz AND a.id::text < $${params.length}::text))`);
      }

      params.push(options.limit);

      const query = `${baseAssessmentSelect}
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length}`;

      const result = await asExecutor(executor).query(query, params);
      return (result.rows as RawAssessmentRow[]).map(mapAssessment);
    },

    async createAssessment(
      input: {
        tenantId: string;
        name: string;
        slug: string;
        description?: string | undefined;
        createdBy: string;
      },
      executor: QueryExecutor = db
    ): Promise<AssessmentRecord> {
      const result = await asExecutor(executor).query(
        `
          INSERT INTO assessments (tenant_id, name, slug, description, status, created_by)
          VALUES ($1, $2, $3, $4, 'draft', $5)
          RETURNING
            id,
            tenant_id AS "tenantId",
            name,
            slug::text AS slug,
            status::text AS status,
            description,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [input.tenantId, input.name, input.slug, input.description ?? null, input.createdBy]
      );

      return mapAssessment(result.rows[0] as RawAssessmentRow);
    },

    async getAssessmentById(tenantId: string, assessmentId: string, executor: QueryExecutor = db): Promise<AssessmentRecord | null> {
      const result = await asExecutor(executor).query(
        `${baseAssessmentSelect}
         WHERE a.id = $1 AND a.tenant_id = $2
         LIMIT 1`,
        [assessmentId, tenantId]
      );

      const row = result.rows[0] as RawAssessmentRow | undefined;
      return row ? mapAssessment(row) : null;
    },

    async getPublishedRuntimeBySlug(slug: string, executor: QueryExecutor = db): Promise<PublishedRuntimeRecord | null> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            a.tenant_id AS "tenantId",
            a.id AS "assessmentId",
            v.id AS "assessmentVersionId",
            v.lead_capture_mode AS "leadCaptureMode",
            v.lead_capture_step AS "leadCaptureStep"
          FROM assessments a
          INNER JOIN assessment_versions v ON v.assessment_id = a.id
          WHERE a.slug = $1
            AND v.is_published = TRUE
          ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
          LIMIT 1
        `,
        [slug]
      );

      const row = result.rows[0] as RawPublishedRuntimeRow | undefined;
      return row ? mapPublishedRuntime(row) : null;
    },

    async updateAssessment(
      tenantId: string,
      assessmentId: string,
      patch: Partial<{ name: string; slug: string; description: string; status: AssessmentStatus }>,
      executor: QueryExecutor = db
    ): Promise<AssessmentRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'name')) {
        params.push(patch.name);
        updates.push(`name = $${params.length}`);
      }
      if (hasProperty(patch, 'slug')) {
        params.push(patch.slug);
        updates.push(`slug = $${params.length}`);
      }
      if (hasProperty(patch, 'description')) {
        params.push(patch.description ?? null);
        updates.push(`description = $${params.length}`);
      }
      if (hasProperty(patch, 'status')) {
        params.push(patch.status);
        updates.push(`status = $${params.length}::assessment_status`);
      }

      if (updates.length === 0) {
        return this.getAssessmentById(tenantId, assessmentId, executor);
      }

      params.push(assessmentId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE assessments
          SET ${updates.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
          RETURNING
            id,
            tenant_id AS "tenantId",
            name,
            slug::text AS slug,
            status::text AS status,
            description,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        params
      );

      const row = result.rows[0] as RawAssessmentRow | undefined;
      return row ? mapAssessment(row) : null;
    },

    async listVersions(tenantId: string, assessmentId: string, executor: QueryExecutor = db): Promise<AssessmentVersionRecord[]> {
      const result = await asExecutor(executor).query(
        `${baseVersionSelect}
         INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE v.assessment_id = $1 AND a.tenant_id = $2
         ORDER BY v.version_no DESC`,
        [assessmentId, tenantId]
      );

      return (result.rows as RawVersionRow[]).map(mapVersion);
    },

    async getVersionById(tenantId: string, versionId: string, executor: QueryExecutor = db): Promise<AssessmentVersionRecord | null> {
      const result = await asExecutor(executor).query(
        `${baseVersionSelect}
         INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE v.id = $1 AND a.tenant_id = $2
         LIMIT 1`,
        [versionId, tenantId]
      );

      const row = result.rows[0] as RawVersionRow | undefined;
      return row ? mapVersion(row) : null;
    },

    async getVersionByAssessment(
      tenantId: string,
      assessmentId: string,
      versionId: string,
      executor: QueryExecutor = db
    ): Promise<AssessmentVersionRecord | null> {
      const result = await asExecutor(executor).query(
        `${baseVersionSelect}
         INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE v.id = $1 AND v.assessment_id = $2 AND a.tenant_id = $3
         LIMIT 1`,
        [versionId, assessmentId, tenantId]
      );

      const row = result.rows[0] as RawVersionRow | undefined;
      return row ? mapVersion(row) : null;
    },

    async getNextVersionNumber(assessmentId: string, executor: QueryExecutor = db): Promise<number> {
      const result = await asExecutor(executor).query(
        `
          SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
          FROM assessment_versions
          WHERE assessment_id = $1
        `,
        [assessmentId]
      );

      const raw = result.rows[0] as { next_version: number | string } | undefined;
      return raw ? toNumber(raw.next_version) : 1;
    },

    async createVersion(
      input: {
        assessmentId: string;
        versionNo: number;
        title: string;
        introCopy?: string | undefined;
        outroCopy?: string | undefined;
        leadCaptureMode?: 'start' | 'middle' | 'before_results' | undefined;
        leadCaptureStep?: number | undefined;
        runtimeSettings?: Record<string, unknown> | undefined;
        createdBy: string;
      },
      executor: QueryExecutor = db
    ): Promise<AssessmentVersionRecord> {
      const result = await asExecutor(executor).query(
        `
          INSERT INTO assessment_versions (
            assessment_id,
            version_no,
            title,
            intro_copy,
            outro_copy,
            lead_capture_mode,
            lead_capture_step,
            runtime_settings,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          RETURNING
            id,
            assessment_id AS "assessmentId",
            version_no AS "versionNo",
            is_published AS "isPublished",
            published_at AS "publishedAt",
            title,
            intro_copy AS "introCopy",
            outro_copy AS "outroCopy",
            lead_capture_mode AS "leadCaptureMode",
            lead_capture_step AS "leadCaptureStep",
            runtime_settings AS "runtimeSettings",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          input.assessmentId,
          input.versionNo,
          input.title,
          input.introCopy ?? null,
          input.outroCopy ?? null,
          input.leadCaptureMode ?? 'before_results',
          input.leadCaptureStep ?? null,
          JSON.stringify(input.runtimeSettings ?? {}),
          input.createdBy
        ]
      );

      return mapVersion(result.rows[0] as RawVersionRow);
    },

    async updateVersion(
      tenantId: string,
      versionId: string,
      patch: Partial<{
        title: string;
        introCopy: string;
        outroCopy: string;
        leadCaptureMode: 'start' | 'middle' | 'before_results';
        leadCaptureStep: number;
        runtimeSettings: Record<string, unknown>;
      }>,
      executor: QueryExecutor = db
    ): Promise<AssessmentVersionRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'title')) {
        params.push(patch.title);
        updates.push(`title = $${params.length}`);
      }
      if (hasProperty(patch, 'introCopy')) {
        params.push(patch.introCopy ?? null);
        updates.push(`intro_copy = $${params.length}`);
      }
      if (hasProperty(patch, 'outroCopy')) {
        params.push(patch.outroCopy ?? null);
        updates.push(`outro_copy = $${params.length}`);
      }
      if (hasProperty(patch, 'leadCaptureMode')) {
        params.push(patch.leadCaptureMode);
        updates.push(`lead_capture_mode = $${params.length}`);
      }
      if (hasProperty(patch, 'leadCaptureStep')) {
        params.push(patch.leadCaptureStep ?? null);
        updates.push(`lead_capture_step = $${params.length}`);
      }
      if (hasProperty(patch, 'runtimeSettings')) {
        params.push(JSON.stringify(patch.runtimeSettings ?? {}));
        updates.push(`runtime_settings = $${params.length}::jsonb`);
      }

      if (updates.length === 0) {
        return this.getVersionById(tenantId, versionId, executor);
      }

      params.push(versionId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE assessment_versions v
          SET ${updates.join(', ')}, updated_at = now()
          FROM assessments a
          WHERE v.assessment_id = a.id
            AND v.id = $${params.length - 1}
            AND a.tenant_id = $${params.length}
          RETURNING
            v.id,
            v.assessment_id AS "assessmentId",
            v.version_no AS "versionNo",
            v.is_published AS "isPublished",
            v.published_at AS "publishedAt",
            v.title,
            v.intro_copy AS "introCopy",
            v.outro_copy AS "outroCopy",
            v.lead_capture_mode AS "leadCaptureMode",
            v.lead_capture_step AS "leadCaptureStep",
            v.runtime_settings AS "runtimeSettings",
            v.created_at AS "createdAt",
            v.updated_at AS "updatedAt"
        `,
        params
      );

      const row = result.rows[0] as RawVersionRow | undefined;
      return row ? mapVersion(row) : null;
    },

    async clearPublishedVersions(assessmentId: string, executor: QueryExecutor = db): Promise<void> {
      await asExecutor(executor).query(
        `
          UPDATE assessment_versions
          SET is_published = FALSE,
              published_at = NULL,
              updated_at = now()
          WHERE assessment_id = $1
            AND is_published = TRUE
        `,
        [assessmentId]
      );
    },

    async publishVersion(versionId: string, executor: QueryExecutor = db): Promise<void> {
      await asExecutor(executor).query(
        `
          UPDATE assessment_versions
          SET is_published = TRUE,
              published_at = now(),
              updated_at = now()
          WHERE id = $1
        `,
        [versionId]
      );
    },

    async updateAssessmentStatus(assessmentId: string, status: AssessmentStatus, executor: QueryExecutor = db): Promise<void> {
      await asExecutor(executor).query(
        `
          UPDATE assessments
          SET status = $2::assessment_status,
              updated_at = now()
          WHERE id = $1
        `,
        [assessmentId, status]
      );
    },

    async getLandingPageByVersion(tenantId: string, versionId: string, executor: QueryExecutor = db): Promise<LandingPageRecord | null> {
      const result = await asExecutor(executor).query(
        `${baseLandingSelect}
          INNER JOIN assessment_versions v ON v.id = lp.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE v.id = $1
           AND a.tenant_id = $2
         LIMIT 1`,
        [versionId, tenantId]
      );

      const row = result.rows[0] as RawLandingPageRow | undefined;
      return row ? mapLandingPage(row) : null;
    },

    async ensureLandingPage(tenantId: string, versionId: string, executor: QueryExecutor = db): Promise<LandingPageRecord | null> {
      await asExecutor(executor).query(
        `
          INSERT INTO landing_pages (assessment_version_id, theme)
          SELECT v.id, '{}'::jsonb
          FROM assessment_versions v
          INNER JOIN assessments a ON a.id = v.assessment_id
          WHERE v.id = $1
            AND a.tenant_id = $2
          ON CONFLICT (assessment_version_id) DO NOTHING
        `,
        [versionId, tenantId]
      );

      return this.getLandingPageByVersion(tenantId, versionId, executor);
    },

    async updateLandingPage(
      tenantId: string,
      versionId: string,
      patch: Partial<{
        seoTitle: string;
        seoDescription: string;
        theme: Record<string, unknown>;
      }>,
      executor: QueryExecutor = db
    ): Promise<LandingPageRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'seoTitle')) {
        params.push(patch.seoTitle ?? null);
        updates.push(`seo_title = $${params.length}`);
      }
      if (hasProperty(patch, 'seoDescription')) {
        params.push(patch.seoDescription ?? null);
        updates.push(`seo_description = $${params.length}`);
      }
      if (hasProperty(patch, 'theme')) {
        params.push(JSON.stringify(patch.theme ?? {}));
        updates.push(`theme = $${params.length}::jsonb`);
      }

      if (updates.length === 0) {
        return this.getLandingPageByVersion(tenantId, versionId, executor);
      }

      params.push(versionId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE landing_pages
          SET ${updates.join(', ')}, updated_at = now()
          WHERE assessment_version_id = $${params.length - 1}
            AND assessment_version_id IN (
              SELECT v.id
              FROM assessment_versions v
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $${params.length}
            )
          RETURNING
            id,
            assessment_version_id AS "assessmentVersionId",
            seo_title AS "seoTitle",
            seo_description AS "seoDescription",
            theme
        `,
        params
      );

      const row = result.rows[0] as RawLandingPageRow | undefined;
      return row ? mapLandingPage(row) : null;
    },

    async listPageBlocks(tenantId: string, versionId: string, executor: QueryExecutor = db): Promise<PageBlockRecord[]> {
      const result = await asExecutor(executor).query(
        `${basePageBlockSelect}
          INNER JOIN landing_pages lp ON lp.id = pb.landing_page_id
          INNER JOIN assessment_versions v ON v.id = lp.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE v.id = $1
           AND a.tenant_id = $2
         ORDER BY pb.position ASC`,
        [versionId, tenantId]
      );

      return (result.rows as RawPageBlockRow[]).map(mapPageBlock);
    },

    async listPageBlocksByLanding(landingPageId: string, executor: QueryExecutor = db): Promise<PageBlockRecord[]> {
      const result = await asExecutor(executor).query(
        `${basePageBlockSelect}
         WHERE pb.landing_page_id = $1
         ORDER BY pb.position ASC`,
        [landingPageId]
      );

      return (result.rows as RawPageBlockRow[]).map(mapPageBlock);
    },

    async createPageBlock(
      input: {
        landingPageId: string;
        type: string;
        position: number;
        config: Record<string, unknown>;
        isVisible: boolean;
      },
      executor: QueryExecutor = db
    ): Promise<PageBlockRecord> {
      const result = await asExecutor(executor).query(
        `
          INSERT INTO page_blocks (landing_page_id, type, position, config, is_visible)
          VALUES ($1, $2, $3, $4::jsonb, $5)
          RETURNING
            id,
            type,
            position,
            config,
            is_visible AS "isVisible"
        `,
        [input.landingPageId, input.type, input.position, JSON.stringify(input.config ?? {}), input.isVisible]
      );

      return mapPageBlock(result.rows[0] as RawPageBlockRow);
    },

    async getPageBlockById(tenantId: string, blockId: string, executor: QueryExecutor = db): Promise<PageBlockWithVersionRecord | null> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            pb.id,
            pb.type,
            pb.position,
            pb.config,
            pb.is_visible AS "isVisible",
            pb.landing_page_id AS "landingPageId",
            lp.assessment_version_id AS "assessmentVersionId"
          FROM page_blocks pb
          INNER JOIN landing_pages lp ON lp.id = pb.landing_page_id
          INNER JOIN assessment_versions v ON v.id = lp.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
          WHERE pb.id = $1
            AND a.tenant_id = $2
          LIMIT 1
        `,
        [blockId, tenantId]
      );

      const row = result.rows[0] as RawPageBlockWithVersionRow | undefined;
      return row ? mapPageBlockWithVersion(row) : null;
    },

    async updatePageBlock(
      tenantId: string,
      blockId: string,
      patch: Partial<{
        type: string;
        position: number;
        config: Record<string, unknown>;
        isVisible: boolean;
      }>,
      executor: QueryExecutor = db
    ): Promise<PageBlockRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'type')) {
        params.push(patch.type);
        updates.push(`type = $${params.length}`);
      }
      if (hasProperty(patch, 'position')) {
        params.push(patch.position);
        updates.push(`position = $${params.length}`);
      }
      if (hasProperty(patch, 'config')) {
        params.push(JSON.stringify(patch.config ?? {}));
        updates.push(`config = $${params.length}::jsonb`);
      }
      if (hasProperty(patch, 'isVisible')) {
        params.push(patch.isVisible);
        updates.push(`is_visible = $${params.length}`);
      }

      if (updates.length === 0) {
        const existing = await this.getPageBlockById(tenantId, blockId, executor);
        return existing ? mapPageBlock(existing) : null;
      }

      params.push(blockId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE page_blocks
          SET ${updates.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1}
            AND landing_page_id IN (
              SELECT lp.id
              FROM landing_pages lp
              INNER JOIN assessment_versions v ON v.id = lp.assessment_version_id
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $${params.length}
            )
          RETURNING
            id,
            type,
            position,
            config,
            is_visible AS "isVisible"
        `,
        params
      );

      const row = result.rows[0] as RawPageBlockRow | undefined;
      return row ? mapPageBlock(row) : null;
    },

    async deletePageBlock(tenantId: string, blockId: string, executor: QueryExecutor = db): Promise<boolean> {
      const result = await asExecutor(executor).query(
        `
          DELETE FROM page_blocks
          WHERE id = $1
            AND landing_page_id IN (
              SELECT lp.id
              FROM landing_pages lp
              INNER JOIN assessment_versions v ON v.id = lp.assessment_version_id
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $2
            )
          RETURNING id
        `,
        [blockId, tenantId]
      );

      return result.rows.length > 0;
    },

    async listQuestions(tenantId: string, versionId: string, executor: QueryExecutor = db): Promise<QuestionRecord[]> {
      const result = await asExecutor(executor).query(
        `${baseQuestionSelect}
          INNER JOIN assessment_versions v ON v.id = q.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE q.assessment_version_id = $1
           AND a.tenant_id = $2
         ORDER BY q.position ASC`,
        [versionId, tenantId]
      );

      return (result.rows as RawQuestionRow[]).map(mapQuestion);
    },

    async listQuestionsByVersion(versionId: string, executor: QueryExecutor = db): Promise<QuestionRecord[]> {
      const result = await asExecutor(executor).query(
        `${baseQuestionSelect}
         WHERE q.assessment_version_id = $1
         ORDER BY q.position ASC`,
        [versionId]
      );

      return (result.rows as RawQuestionRow[]).map(mapQuestion);
    },

    async getQuestionById(tenantId: string, questionId: string, executor: QueryExecutor = db): Promise<QuestionRecord | null> {
      const result = await asExecutor(executor).query(
        `${baseQuestionSelect}
          INNER JOIN assessment_versions v ON v.id = q.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
         WHERE q.id = $1
           AND a.tenant_id = $2
         LIMIT 1`,
        [questionId, tenantId]
      );

      const row = result.rows[0] as RawQuestionRow | undefined;
      return row ? mapQuestion(row) : null;
    },

    async createQuestion(
      input: {
        versionId: string;
        type: QuestionType;
        prompt: string;
        helpText?: string | undefined;
        isRequired: boolean;
        position: number;
        weight: number;
        minValue?: number | undefined;
        maxValue?: number | undefined;
        metadata?: Record<string, unknown> | undefined;
      },
      executor: QueryExecutor = db
    ): Promise<QuestionRecord> {
      const result = await asExecutor(executor).query(
        `
          INSERT INTO questions (
            assessment_version_id,
            type,
            prompt,
            help_text,
            is_required,
            position,
            weight,
            min_value,
            max_value,
            metadata
          )
          VALUES ($1, $2::question_type, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          RETURNING
            id,
            assessment_version_id AS "assessmentVersionId",
            type::text AS type,
            prompt,
            help_text AS "helpText",
            is_required AS "isRequired",
            position,
            weight,
            min_value AS "minValue",
            max_value AS "maxValue",
            metadata,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          input.versionId,
          input.type,
          input.prompt,
          input.helpText ?? null,
          input.isRequired,
          input.position,
          input.weight,
          input.minValue ?? null,
          input.maxValue ?? null,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      return mapQuestion(result.rows[0] as RawQuestionRow);
    },

    async updateQuestion(
      tenantId: string,
      questionId: string,
      patch: Partial<{
        prompt: string;
        helpText: string;
        isRequired: boolean;
        position: number;
        weight: number;
        minValue: number;
        maxValue: number;
        metadata: Record<string, unknown>;
      }>,
      executor: QueryExecutor = db
    ): Promise<QuestionRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'prompt')) {
        params.push(patch.prompt);
        updates.push(`prompt = $${params.length}`);
      }
      if (hasProperty(patch, 'helpText')) {
        params.push(patch.helpText ?? null);
        updates.push(`help_text = $${params.length}`);
      }
      if (hasProperty(patch, 'isRequired')) {
        params.push(patch.isRequired);
        updates.push(`is_required = $${params.length}`);
      }
      if (hasProperty(patch, 'position')) {
        params.push(patch.position);
        updates.push(`position = $${params.length}`);
      }
      if (hasProperty(patch, 'weight')) {
        params.push(patch.weight);
        updates.push(`weight = $${params.length}`);
      }
      if (hasProperty(patch, 'minValue')) {
        params.push(patch.minValue ?? null);
        updates.push(`min_value = $${params.length}`);
      }
      if (hasProperty(patch, 'maxValue')) {
        params.push(patch.maxValue ?? null);
        updates.push(`max_value = $${params.length}`);
      }
      if (hasProperty(patch, 'metadata')) {
        params.push(JSON.stringify(patch.metadata ?? {}));
        updates.push(`metadata = $${params.length}::jsonb`);
      }

      if (updates.length === 0) {
        return this.getQuestionById(tenantId, questionId, executor);
      }

      params.push(questionId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE questions
          SET ${updates.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1}
            AND assessment_version_id IN (
              SELECT v.id
              FROM assessment_versions v
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $${params.length}
            )
          RETURNING
            id,
            assessment_version_id AS "assessmentVersionId",
            type::text AS type,
            prompt,
            help_text AS "helpText",
            is_required AS "isRequired",
            position,
            weight,
            min_value AS "minValue",
            max_value AS "maxValue",
            metadata,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        params
      );

      const row = result.rows[0] as RawQuestionRow | undefined;
      return row ? mapQuestion(row) : null;
    },

    async deleteQuestion(tenantId: string, questionId: string, executor: QueryExecutor = db): Promise<boolean> {
      const result = await asExecutor(executor).query(
        `
          DELETE FROM questions
          WHERE id = $1
            AND assessment_version_id IN (
              SELECT v.id
              FROM assessment_versions v
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $2
            )
          RETURNING id
        `,
        [questionId, tenantId]
      );

      return result.rows.length > 0;
    },

    async listAnswerOptions(tenantId: string, questionId: string, executor: QueryExecutor = db): Promise<AnswerOptionRecord[]> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            ao.id,
            ao.question_id AS "questionId",
            ao.label,
            ao.value,
            ao.score_value AS "scoreValue",
            ao.position,
            ao.metadata
          FROM answer_options ao
          INNER JOIN questions q ON q.id = ao.question_id
          INNER JOIN assessment_versions v ON v.id = q.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
          WHERE ao.question_id = $1
            AND a.tenant_id = $2
          ORDER BY ao.position ASC
        `,
        [questionId, tenantId]
      );

      return (result.rows as RawOptionRow[]).map(mapOption);
    },

    async listAnswerOptionsByQuestion(questionId: string, executor: QueryExecutor = db): Promise<AnswerOptionRecord[]> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            ao.id,
            ao.question_id AS "questionId",
            ao.label,
            ao.value,
            ao.score_value AS "scoreValue",
            ao.position,
            ao.metadata
          FROM answer_options ao
          WHERE ao.question_id = $1
          ORDER BY ao.position ASC
        `,
        [questionId]
      );

      return (result.rows as RawOptionRow[]).map(mapOption);
    },

    async getAnswerOptionById(tenantId: string, optionId: string, executor: QueryExecutor = db): Promise<AnswerOptionRecord | null> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            ao.id,
            ao.question_id AS "questionId",
            ao.label,
            ao.value,
            ao.score_value AS "scoreValue",
            ao.position,
            ao.metadata
          FROM answer_options ao
          INNER JOIN questions q ON q.id = ao.question_id
          INNER JOIN assessment_versions v ON v.id = q.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
          WHERE ao.id = $1
            AND a.tenant_id = $2
          LIMIT 1
        `,
        [optionId, tenantId]
      );

      const row = result.rows[0] as RawOptionRow | undefined;
      return row ? mapOption(row) : null;
    },

    async createAnswerOption(
      input: {
        questionId: string;
        label: string;
        value: string;
        scoreValue: number;
        position: number;
        metadata?: Record<string, unknown> | undefined;
      },
      executor: QueryExecutor = db
    ): Promise<AnswerOptionRecord> {
      const result = await asExecutor(executor).query(
        `
          INSERT INTO answer_options (question_id, label, value, score_value, position, metadata)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          RETURNING
            id,
            question_id AS "questionId",
            label,
            value,
            score_value AS "scoreValue",
            position,
            metadata
        `,
        [input.questionId, input.label, input.value, input.scoreValue, input.position, JSON.stringify(input.metadata ?? {})]
      );

      return mapOption(result.rows[0] as RawOptionRow);
    },

    async updateAnswerOption(
      tenantId: string,
      optionId: string,
      patch: Partial<{
        label: string;
        value: string;
        scoreValue: number;
        position: number;
        metadata: Record<string, unknown>;
      }>,
      executor: QueryExecutor = db
    ): Promise<AnswerOptionRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'label')) {
        params.push(patch.label);
        updates.push(`label = $${params.length}`);
      }
      if (hasProperty(patch, 'value')) {
        params.push(patch.value);
        updates.push(`value = $${params.length}`);
      }
      if (hasProperty(patch, 'scoreValue')) {
        params.push(patch.scoreValue);
        updates.push(`score_value = $${params.length}`);
      }
      if (hasProperty(patch, 'position')) {
        params.push(patch.position);
        updates.push(`position = $${params.length}`);
      }
      if (hasProperty(patch, 'metadata')) {
        params.push(JSON.stringify(patch.metadata ?? {}));
        updates.push(`metadata = $${params.length}::jsonb`);
      }

      if (updates.length === 0) {
        return this.getAnswerOptionById(tenantId, optionId, executor);
      }

      params.push(optionId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE answer_options
          SET ${updates.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1}
            AND question_id IN (
              SELECT q.id
              FROM questions q
              INNER JOIN assessment_versions v ON v.id = q.assessment_version_id
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $${params.length}
            )
          RETURNING
            id,
            question_id AS "questionId",
            label,
            value,
            score_value AS "scoreValue",
            position,
            metadata
        `,
        params
      );

      const row = result.rows[0] as RawOptionRow | undefined;
      return row ? mapOption(row) : null;
    },

    async deleteAnswerOption(tenantId: string, optionId: string, executor: QueryExecutor = db): Promise<boolean> {
      const result = await asExecutor(executor).query(
        `
          DELETE FROM answer_options
          WHERE id = $1
            AND question_id IN (
              SELECT q.id
              FROM questions q
              INNER JOIN assessment_versions v ON v.id = q.assessment_version_id
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $2
            )
          RETURNING id
        `,
        [optionId, tenantId]
      );

      return result.rows.length > 0;
    },

    async listLogicRules(tenantId: string, versionId: string, executor: QueryExecutor = db): Promise<LogicRuleRecord[]> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            lr.id,
            lr.assessment_version_id AS "assessmentVersionId",
            lr.name,
            lr.priority,
            lr.if_expression AS "ifExpression",
            lr.then_action AS "thenAction",
            lr.is_active AS "isActive"
          FROM logic_rules lr
          INNER JOIN assessment_versions v ON v.id = lr.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
          WHERE lr.assessment_version_id = $1
            AND a.tenant_id = $2
          ORDER BY lr.priority ASC, lr.created_at ASC
        `,
        [versionId, tenantId]
      );

      return (result.rows as RawLogicRuleRow[]).map(mapLogicRule);
    },

    async listLogicRulesByVersion(versionId: string, executor: QueryExecutor = db): Promise<LogicRuleRecord[]> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            lr.id,
            lr.assessment_version_id AS "assessmentVersionId",
            lr.name,
            lr.priority,
            lr.if_expression AS "ifExpression",
            lr.then_action AS "thenAction",
            lr.is_active AS "isActive"
          FROM logic_rules lr
          WHERE lr.assessment_version_id = $1
          ORDER BY lr.priority ASC, lr.created_at ASC
        `,
        [versionId]
      );

      return (result.rows as RawLogicRuleRow[]).map(mapLogicRule);
    },

    async getLogicRuleById(tenantId: string, ruleId: string, executor: QueryExecutor = db): Promise<LogicRuleRecord | null> {
      const result = await asExecutor(executor).query(
        `
          SELECT
            lr.id,
            lr.assessment_version_id AS "assessmentVersionId",
            lr.name,
            lr.priority,
            lr.if_expression AS "ifExpression",
            lr.then_action AS "thenAction",
            lr.is_active AS "isActive"
          FROM logic_rules lr
          INNER JOIN assessment_versions v ON v.id = lr.assessment_version_id
          INNER JOIN assessments a ON a.id = v.assessment_id
          WHERE lr.id = $1
            AND a.tenant_id = $2
          LIMIT 1
        `,
        [ruleId, tenantId]
      );

      const row = result.rows[0] as RawLogicRuleRow | undefined;
      return row ? mapLogicRule(row) : null;
    },

    async createLogicRule(
      input: {
        versionId: string;
        name: string;
        priority: number;
        ifExpression: Record<string, unknown>;
        thenAction: Record<string, unknown>;
        isActive: boolean;
      },
      executor: QueryExecutor = db
    ): Promise<LogicRuleRecord> {
      const result = await asExecutor(executor).query(
        `
          INSERT INTO logic_rules (assessment_version_id, name, priority, if_expression, then_action, is_active)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
          RETURNING
            id,
            assessment_version_id AS "assessmentVersionId",
            name,
            priority,
            if_expression AS "ifExpression",
            then_action AS "thenAction",
            is_active AS "isActive"
        `,
        [
          input.versionId,
          input.name,
          input.priority,
          JSON.stringify(input.ifExpression),
          JSON.stringify(input.thenAction),
          input.isActive
        ]
      );

      return mapLogicRule(result.rows[0] as RawLogicRuleRow);
    },

    async updateLogicRule(
      tenantId: string,
      ruleId: string,
      patch: Partial<{
        name: string;
        priority: number;
        ifExpression: Record<string, unknown>;
        thenAction: Record<string, unknown>;
        isActive: boolean;
      }>,
      executor: QueryExecutor = db
    ): Promise<LogicRuleRecord | null> {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (hasProperty(patch, 'name')) {
        params.push(patch.name);
        updates.push(`name = $${params.length}`);
      }
      if (hasProperty(patch, 'priority')) {
        params.push(patch.priority);
        updates.push(`priority = $${params.length}`);
      }
      if (hasProperty(patch, 'ifExpression')) {
        params.push(JSON.stringify(patch.ifExpression ?? {}));
        updates.push(`if_expression = $${params.length}::jsonb`);
      }
      if (hasProperty(patch, 'thenAction')) {
        params.push(JSON.stringify(patch.thenAction ?? {}));
        updates.push(`then_action = $${params.length}::jsonb`);
      }
      if (hasProperty(patch, 'isActive')) {
        params.push(patch.isActive);
        updates.push(`is_active = $${params.length}`);
      }

      if (updates.length === 0) {
        return this.getLogicRuleById(tenantId, ruleId, executor);
      }

      params.push(ruleId, tenantId);
      const result = await asExecutor(executor).query(
        `
          UPDATE logic_rules
          SET ${updates.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1}
            AND assessment_version_id IN (
              SELECT v.id
              FROM assessment_versions v
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $${params.length}
            )
          RETURNING
            id,
            assessment_version_id AS "assessmentVersionId",
            name,
            priority,
            if_expression AS "ifExpression",
            then_action AS "thenAction",
            is_active AS "isActive"
        `,
        params
      );

      const row = result.rows[0] as RawLogicRuleRow | undefined;
      return row ? mapLogicRule(row) : null;
    },

    async deleteLogicRule(tenantId: string, ruleId: string, executor: QueryExecutor = db): Promise<boolean> {
      const result = await asExecutor(executor).query(
        `
          DELETE FROM logic_rules
          WHERE id = $1
            AND assessment_version_id IN (
              SELECT v.id
              FROM assessment_versions v
              INNER JOIN assessments a ON a.id = v.assessment_id
              WHERE a.tenant_id = $2
            )
          RETURNING id
        `,
        [ruleId, tenantId]
      );

      return result.rows.length > 0;
    }
  };
}

export type AssessmentsRepository = ReturnType<typeof createAssessmentsRepository>;
