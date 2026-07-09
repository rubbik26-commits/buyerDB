-- 019_backend_workflow_tables.sql
-- Persistence tables used by the FastAPI backend workflow routes.
-- Intentionally avoids FKs to canonical tables so it is safe in live Supabase mode,
-- where canonical names may be views over sbi_* tables.

BEGIN;

CREATE TABLE IF NOT EXISTS saved_views (
  view_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT 'broker',
  name text NOT NULL,
  surface text NOT NULL CHECK (surface IN ('deals','buyers','properties','outreach','audit')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, surface, name)
);
CREATE INDEX IF NOT EXISTS saved_views_user_surface ON saved_views (user_id, surface, updated_at DESC);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  draft_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid,
  user_id text NOT NULL DEFAULT 'broker',
  property_summary text,
  subject text NOT NULL,
  body text NOT NULL,
  status text CHECK (status IN ('draft','copied','sent_elsewhere','dismissed')) DEFAULT 'draft',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_drafts_entity ON outreach_drafts (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outreach_drafts_status ON outreach_drafts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_task_overrides (
  task_key text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'broker',
  status text CHECK (status IN ('open','done','dismissed')) DEFAULT 'open',
  note text,
  updated_at timestamptz DEFAULT now()
);

COMMIT;
