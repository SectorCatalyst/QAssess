-- QAssess Postgres schema (v0.3)
-- Compatible with PostgreSQL 15+

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- -----------------------------
-- Enum types
-- -----------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('owner', 'editor', 'analyst', 'viewer');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'assessment_status') THEN
    CREATE TYPE assessment_status AS ENUM ('draft', 'published', 'archived');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_type') THEN
    CREATE TYPE question_type AS ENUM ('single_choice', 'multi_choice', 'scale', 'numeric', 'short_text');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_status') THEN
    CREATE TYPE session_status AS ENUM ('in_progress', 'completed', 'abandoned');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pdf_job_status') THEN
    CREATE TYPE pdf_job_status AS ENUM ('queued', 'processing', 'completed', 'failed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'webhook_delivery_status') THEN
    CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'sent', 'failed', 'dead_letter');
  END IF;
END$$;

-- -----------------------------
-- Trigger utility
-- -----------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------
-- Core tenancy and access
-- -----------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug CITEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'active',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  first_name TEXT,
  last_name TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_email_unique UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_role ON users (tenant_id, role);

CREATE TRIGGER trg_tenants_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Assessments and versioning
-- -----------------------------

CREATE TABLE IF NOT EXISTS assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug CITEXT NOT NULL,
  status assessment_status NOT NULL DEFAULT 'draft',
  description TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assessments_tenant_slug_unique UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS assessment_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  title TEXT NOT NULL,
  intro_copy TEXT,
  outro_copy TEXT,
  lead_capture_mode TEXT NOT NULL DEFAULT 'before_results', -- start | middle | before_results
  lead_capture_step INTEGER CHECK (lead_capture_step IS NULL OR lead_capture_step >= 1),
  runtime_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assessment_versions_assessment_version_unique UNIQUE (assessment_id, version_no),
  CONSTRAINT assessment_versions_publish_consistency
    CHECK ((is_published = FALSE) OR (published_at IS NOT NULL))
);

-- Exactly one published version per assessment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_versions_one_published
  ON assessment_versions (assessment_id)
  WHERE is_published = TRUE;

CREATE INDEX IF NOT EXISTS idx_assessments_tenant_status ON assessments (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_versions_assessment_created ON assessment_versions (assessment_id, created_at DESC);

CREATE TRIGGER trg_assessments_updated_at
BEFORE UPDATE ON assessments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_assessment_versions_updated_at
BEFORE UPDATE ON assessment_versions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Landing page builder
-- -----------------------------

CREATE TABLE IF NOT EXISTS landing_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_version_id UUID NOT NULL UNIQUE REFERENCES assessment_versions(id) ON DELETE CASCADE,
  seo_title TEXT,
  seo_description TEXT,
  theme JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS page_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_page_id UUID NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- hero | cta | form | faq | footer | etc.
  position INTEGER NOT NULL CHECK (position >= 1),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT page_blocks_landing_position_unique UNIQUE (landing_page_id, position)
);

CREATE INDEX IF NOT EXISTS idx_page_blocks_landing_visible ON page_blocks (landing_page_id, is_visible, position);

CREATE TRIGGER trg_landing_pages_updated_at
BEFORE UPDATE ON landing_pages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_page_blocks_updated_at
BEFORE UPDATE ON page_blocks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Questions, options, and logic
-- -----------------------------

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_version_id UUID NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  type question_type NOT NULL,
  prompt TEXT NOT NULL,
  help_text TEXT,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL CHECK (position >= 1),
  weight NUMERIC(8,4) NOT NULL DEFAULT 1.0000 CHECK (weight >= 0 AND weight <= 10),
  min_value NUMERIC(12,4),
  max_value NUMERIC(12,4),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT questions_version_position_unique UNIQUE (assessment_version_id, position)
);

CREATE TABLE IF NOT EXISTS answer_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  score_value NUMERIC(12,4) NOT NULL DEFAULT 0,
  position INTEGER NOT NULL CHECK (position >= 1),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT answer_options_question_position_unique UNIQUE (question_id, position)
);

CREATE TABLE IF NOT EXISTS logic_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_version_id UUID NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 1),
  if_expression JSONB NOT NULL,
  then_action JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_questions_version_position ON questions (assessment_version_id, position);
CREATE INDEX IF NOT EXISTS idx_answer_options_question_position ON answer_options (question_id, position);
CREATE INDEX IF NOT EXISTS idx_logic_rules_version_priority ON logic_rules (assessment_version_id, is_active, priority);

CREATE TRIGGER trg_questions_updated_at
BEFORE UPDATE ON questions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_answer_options_updated_at
BEFORE UPDATE ON answer_options
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_logic_rules_updated_at
BEFORE UPDATE ON logic_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Scoring bands and reporting templates
-- -----------------------------

CREATE TABLE IF NOT EXISTS score_bands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_version_id UUID NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_score NUMERIC(6,2) NOT NULL CHECK (min_score >= 0),
  max_score NUMERIC(6,2) NOT NULL CHECK (max_score <= 100),
  color_hex TEXT,
  summary TEXT,
  recommendation_template TEXT,
  position INTEGER NOT NULL CHECK (position >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT score_bands_version_position_unique UNIQUE (assessment_version_id, position),
  CONSTRAINT score_bands_range_valid CHECK (min_score <= max_score)
);

CREATE TABLE IF NOT EXISTS report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_version_id UUID NOT NULL UNIQUE REFERENCES assessment_versions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  header_content JSONB NOT NULL DEFAULT '{}'::jsonb,
  footer_content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_template_id UUID NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body_template TEXT NOT NULL,
  display_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL CHECK (position >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT report_sections_template_position_unique UNIQUE (report_template_id, position),
  CONSTRAINT report_sections_template_key_unique UNIQUE (report_template_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_score_bands_version_position ON score_bands (assessment_version_id, position);
CREATE INDEX IF NOT EXISTS idx_report_sections_template_position ON report_sections (report_template_id, position);

CREATE TRIGGER trg_score_bands_updated_at
BEFORE UPDATE ON score_bands
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_report_templates_updated_at
BEFORE UPDATE ON report_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_report_sections_updated_at
BEFORE UPDATE ON report_sections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Leads, sessions, and responses
-- -----------------------------

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  email CITEXT,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  company TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ,
  source_utm JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leads_email_format_check
    CHECK (email IS NULL OR POSITION('@' IN email::TEXT) > 1),
  CONSTRAINT leads_consent_consistency
    CHECK ((consent = FALSE AND consent_at IS NULL) OR (consent = TRUE AND consent_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_assessment ON leads (tenant_id, assessment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_email ON leads (tenant_id, email);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  assessment_version_id UUID NOT NULL REFERENCES assessment_versions(id) ON DELETE RESTRICT,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  status session_status NOT NULL DEFAULT 'in_progress',
  current_question_position INTEGER CHECK (current_question_position IS NULL OR current_question_position >= 1),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  runtime_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_fingerprint TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessions_completion_consistency
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_sessions_assessment_status ON sessions (assessment_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_version_status ON sessions (assessment_version_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_lead ON sessions (lead_id);

CREATE TABLE IF NOT EXISTS responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer_json JSONB NOT NULL,
  computed_score NUMERIC(12,4) NOT NULL DEFAULT 0,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT responses_session_question_unique UNIQUE (session_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_responses_session_answered ON responses (session_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_responses_question ON responses (question_id);

CREATE TABLE IF NOT EXISTS results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  score_band_id UUID REFERENCES score_bands(id) ON DELETE SET NULL,
  raw_score NUMERIC(12,4) NOT NULL DEFAULT 0,
  normalized_score NUMERIC(6,2) NOT NULL CHECK (normalized_score >= 0 AND normalized_score <= 100),
  max_possible_raw_score NUMERIC(12,4) NOT NULL DEFAULT 0,
  breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_results_band ON results (score_band_id, finalized_at DESC);

CREATE TRIGGER trg_leads_updated_at
BEFORE UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sessions_updated_at
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_responses_updated_at
BEFORE UPDATE ON responses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_results_updated_at
BEFORE UPDATE ON results
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- PDF jobs and delivery
-- -----------------------------

CREATE TABLE IF NOT EXISTS pdf_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status pdf_job_status NOT NULL DEFAULT 'queued',
  storage_key TEXT,
  file_url TEXT,
  requested_by_email CITEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status_queued ON pdf_jobs (status, queued_at);
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_session ON pdf_jobs (session_id, created_at DESC);

CREATE TRIGGER trg_pdf_jobs_updated_at
BEFORE UPDATE ON pdf_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Integrations and webhooks
-- -----------------------------

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  subscribed_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant_active ON webhook_endpoints (tenant_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- lead.created | session.completed | pdf.generated
  dedupe_key TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant_type_created ON webhook_events (tenant_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_dedupe_key ON webhook_events (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  webhook_endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_event_endpoint_unique UNIQUE (webhook_event_id, webhook_endpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending_retry ON webhook_deliveries (status, next_retry_at);

CREATE TRIGGER trg_webhook_endpoints_updated_at
BEFORE UPDATE ON webhook_endpoints
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_webhook_deliveries_updated_at
BEFORE UPDATE ON webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Analytics and observability
-- -----------------------------

CREATE TABLE IF NOT EXISTS analytics_daily_assessment (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  date_key DATE NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0 CHECK (visits >= 0),
  starts INTEGER NOT NULL DEFAULT 0 CHECK (starts >= 0),
  completions INTEGER NOT NULL DEFAULT 0 CHECK (completions >= 0),
  leads INTEGER NOT NULL DEFAULT 0 CHECK (leads >= 0),
  avg_score NUMERIC(6,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_assessment_unique UNIQUE (tenant_id, assessment_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_assessment_date ON analytics_daily_assessment (tenant_id, date_key DESC);

CREATE TABLE IF NOT EXISTS analytics_daily_question_dropoff (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_version_id UUID NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  date_key DATE NOT NULL,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  exits INTEGER NOT NULL DEFAULT 0 CHECK (exits >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_question_dropoff_unique UNIQUE (tenant_id, assessment_version_id, question_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_analytics_dropoff_date ON analytics_daily_question_dropoff (tenant_id, date_key DESC);

CREATE TRIGGER trg_analytics_daily_assessment_updated_at
BEFORE UPDATE ON analytics_daily_assessment
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_analytics_daily_question_dropoff_updated_at
BEFORE UPDATE ON analytics_daily_question_dropoff
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------
-- Audit logs
-- -----------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,      -- assessment.publish, question.update, etc.
  target_type TEXT NOT NULL, -- assessment, version, question, block, etc.
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs (target_type, target_id, created_at DESC);

COMMIT;
