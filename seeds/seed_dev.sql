-- =============================================================================
-- seed_dev.sql — development org seed
--
-- Run this manually in local and staging environments only.
-- NEVER run against production Cloud SQL.
--
-- Usage:
--   psql $DATABASE_URL -f migrations/seed_dev.sql
-- =============================================================================

DO $$
BEGIN
  IF current_database() NOT LIKE '%dev%'
     AND current_database() NOT LIKE '%test%'
     AND current_database() NOT LIKE '%local%'
     AND current_database() NOT LIKE '%staging%' THEN
    RAISE EXCEPTION
      'seed_dev.sql must not run against production. Current database: %',
      current_database();
  END IF;
END $$;

-- org_api_key_hash is sha256("dev-api-key-replace-in-prod")
-- Generated with: echo -n "dev-api-key-replace-in-prod" | sha256sum
INSERT INTO org (name, is_active, org_api_key_hash)
VALUES (
  'OKC Thunder (Dev)',
  true,
  'a3d6e2b1c9f4a7d8e5b2c0f3a6d9e1b4c7f0a3d6e2b1c9f4a7d8e5b2c0f3a6'
)
ON CONFLICT (org_api_key_hash) DO NOTHING;
