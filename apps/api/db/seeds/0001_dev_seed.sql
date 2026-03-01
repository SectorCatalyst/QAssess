-- Dev seed for M1 foundation
-- Login credentials after seed:
-- tenantSlug: acme
-- email: owner@acme.example
-- password: ChangeMe123!

BEGIN;

WITH tenant_upsert AS (
  INSERT INTO tenants (name, slug, plan, status)
  VALUES ('Acme Advisory', 'acme', 'pro', 'active')
  ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      plan = EXCLUDED.plan,
      status = EXCLUDED.status
  RETURNING id
)
INSERT INTO users (tenant_id, email, password_hash, role, status, first_name, last_name)
SELECT
  tenant_upsert.id,
  'owner@acme.example',
  crypt('ChangeMe123!', gen_salt('bf')),
  'owner',
  'active',
  'Acme',
  'Owner'
FROM tenant_upsert
ON CONFLICT (tenant_id, email) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name;

COMMIT;
