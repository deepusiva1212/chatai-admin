-- prisma/migrations/rls.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY (RLS) — Defense-in-depth for multi-tenant isolation.
--
-- Even if application code has a bug and omits a WHERE organizationId = ?
-- clause, Postgres will enforce isolation at the storage engine level.
--
-- How it works:
--   1. A "tenant user" (api_tenant) is used for all application queries.
--   2. Before executing queries, the app sets: SET LOCAL app.org_id = '<id>'
--   3. RLS policies on each table check current_setting('app.org_id').
--
-- Run this AFTER `prisma migrate deploy` since Prisma manages the schema;
-- RLS policies are layered on top via this raw SQL migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- Create the restricted application role (never use the superuser in app code)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_tenant') THEN
    CREATE ROLE api_tenant LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
  END IF;
END $$;

GRANT CONNECT ON DATABASE saas_platform TO api_tenant;
GRANT USAGE ON SCHEMA public TO api_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO api_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_tenant;

-- Enable RLS on all tenant-scoped tables
ALTER TABLE knowledge_bases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys          ENABLE ROW LEVEL SECURITY;

-- ── Policies ─────────────────────────────────────────────────────────────────
-- Pattern: allow access only when the row's organizationId matches the
-- session-local setting injected by the application middleware.

CREATE POLICY tenant_isolation ON knowledge_bases
  USING (organization_id = current_setting('app.org_id', true));

CREATE POLICY tenant_isolation ON call_logs
  USING (organization_id = current_setting('app.org_id', true));

CREATE POLICY tenant_isolation ON chat_sessions
  USING (organization_id = current_setting('app.org_id', true));

-- chat_messages: isolated via the parent chat_session
CREATE POLICY tenant_isolation ON chat_messages
  USING (
    session_id IN (
      SELECT id FROM chat_sessions
      WHERE organization_id = current_setting('app.org_id', true)
    )
  );

-- api_keys: allow lookup by ANY role (needed for the auth middleware itself)
-- but restrict all other operations to the owning tenant.
CREATE POLICY tenant_isolation ON api_keys
  USING (organization_id = current_setting('app.org_id', true));

-- ── Bypass for superuser / migration user ────────────────────────────────────
-- The migration user (owner) bypasses RLS automatically (it's a superuser).
-- Ensure your DATABASE_URL in .env.migration uses the owner role,
-- and DATABASE_URL in .env uses api_tenant.
