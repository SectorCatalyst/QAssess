-- M3 landing builder migration: landing pages and configurable page blocks
-- PostgreSQL 15+

BEGIN;

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
  type TEXT NOT NULL,
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

INSERT INTO landing_pages (assessment_version_id, theme)
SELECT v.id, '{}'::jsonb
FROM assessment_versions v
ON CONFLICT (assessment_version_id) DO NOTHING;

COMMIT;
