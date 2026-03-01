-- M5 migration: report templates, webhooks, and analytics aggregates
-- PostgreSQL 15+

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'webhook_delivery_status') THEN
    CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'sent', 'failed', 'dead_letter');
  END IF;
END$$;

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

CREATE INDEX IF NOT EXISTS idx_report_sections_template_position ON report_sections (report_template_id, position);

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
  event_type TEXT NOT NULL,
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

CREATE TRIGGER trg_report_templates_updated_at
BEFORE UPDATE ON report_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_report_sections_updated_at
BEFORE UPDATE ON report_sections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_webhook_endpoints_updated_at
BEFORE UPDATE ON webhook_endpoints
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_webhook_deliveries_updated_at
BEFORE UPDATE ON webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_analytics_daily_assessment_updated_at
BEFORE UPDATE ON analytics_daily_assessment
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_analytics_daily_question_dropoff_updated_at
BEFORE UPDATE ON analytics_daily_question_dropoff
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
