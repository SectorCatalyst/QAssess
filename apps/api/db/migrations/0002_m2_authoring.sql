-- M2 authoring migration: assessments, versions, questions, options, logic rules
-- PostgreSQL 15+

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'assessment_status') THEN
    CREATE TYPE assessment_status AS ENUM ('draft', 'published', 'archived');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_type') THEN
    CREATE TYPE question_type AS ENUM ('single_choice', 'multi_choice', 'scale', 'numeric', 'short_text');
  END IF;
END$$;

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
  lead_capture_mode TEXT NOT NULL DEFAULT 'before_results',
  lead_capture_step INTEGER CHECK (lead_capture_step IS NULL OR lead_capture_step >= 1),
  runtime_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assessment_versions_assessment_version_unique UNIQUE (assessment_id, version_no),
  CONSTRAINT assessment_versions_publish_consistency CHECK ((is_published = FALSE) OR (published_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_versions_one_published
  ON assessment_versions (assessment_id)
  WHERE is_published = TRUE;

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

CREATE INDEX IF NOT EXISTS idx_assessments_tenant_status ON assessments (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_versions_assessment_created ON assessment_versions (assessment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_version_position ON questions (assessment_version_id, position);
CREATE INDEX IF NOT EXISTS idx_answer_options_question_position ON answer_options (question_id, position);
CREATE INDEX IF NOT EXISTS idx_logic_rules_version_priority ON logic_rules (assessment_version_id, is_active, priority);

CREATE TRIGGER trg_assessments_updated_at
BEFORE UPDATE ON assessments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_assessment_versions_updated_at
BEFORE UPDATE ON assessment_versions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_questions_updated_at
BEFORE UPDATE ON questions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_answer_options_updated_at
BEFORE UPDATE ON answer_options
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_logic_rules_updated_at
BEFORE UPDATE ON logic_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
