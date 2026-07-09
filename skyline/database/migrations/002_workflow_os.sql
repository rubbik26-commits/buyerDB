-- 002_workflow_os.sql — persistent workflow layer for Buyer Intelligence OS
-- This migration must be safe before the full sbi base schema is present.
BEGIN;

CREATE TABLE IF NOT EXISTS sbi_saved_views (
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
CREATE INDEX IF NOT EXISTS sbi_saved_views_user_surface ON sbi_saved_views (user_id, surface, updated_at DESC);

CREATE TABLE IF NOT EXISTS sbi_outreach_drafts (
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
CREATE INDEX IF NOT EXISTS sbi_outreach_drafts_entity ON sbi_outreach_drafts (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sbi_outreach_drafts_status ON sbi_outreach_drafts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS sbi_workflow_task_overrides (
  task_key text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'broker',
  status text CHECK (status IN ('open','done','dismissed')) DEFAULT 'open',
  note text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sbi_uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT 'broker',
  filename text,
  row_count integer NOT NULL DEFAULT 0,
  column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'staged',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sbi_upload_rows (
  upload_id uuid REFERENCES sbi_uploads(upload_id) ON DELETE CASCADE,
  row_num integer NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'staged',
  resolution jsonb,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (upload_id, row_num)
);
CREATE INDEX IF NOT EXISTS sbi_upload_rows_upload ON sbi_upload_rows(upload_id, row_num);

COMMIT;
