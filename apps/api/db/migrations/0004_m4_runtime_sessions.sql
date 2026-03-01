-- M4 runtime/session migration: public sessions, lead capture, responses, results, and pdf jobs
-- PostgreSQL 15+

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_status') THEN
    CREATE TYPE session_status AS ENUM ('in_progress', 'completed', 'abandoned');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pdf_job_status') THEN
    CREATE TYPE pdf_job_status AS ENUM ('queued', 'processing', 'completed', 'failed');
  END IF;
END$$;

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

CREATE INDEX IF NOT EXISTS idx_score_bands_version_position ON score_bands (assessment_version_id, position);

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
  CONSTRAINT leads_email_format_check CHECK (email IS NULL OR POSITION('@' IN email::TEXT) > 1),
  CONSTRAINT leads_consent_consistency CHECK ((consent = FALSE AND consent_at IS NULL) OR (consent = TRUE AND consent_at IS NOT NULL))
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
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessions_completion_consistency CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR (status <> 'completed' AND completed_at IS NULL))
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

CREATE TRIGGER trg_score_bands_updated_at
BEFORE UPDATE ON score_bands
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

CREATE TRIGGER trg_pdf_jobs_updated_at
BEFORE UPDATE ON pdf_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
