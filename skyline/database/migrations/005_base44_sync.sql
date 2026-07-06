-- 005: Base44 → Supabase deal sync bridge (applied to prod 2026-07-06 as
-- skyline_005_base44_sync). The dealflow edge functions (acris-v2, traded-daily,
-- crexi-ingest, …) write new deals into the Base44 app; the buyerdb.netlify.app
-- frontend reads THIS database. sync_upsert_deals() closes that gap while keeping
-- every Skyline invariant. Superseded function body: see 006 (null-date dedupe).

CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;  -- no policies: service_role/owner only

CREATE TABLE IF NOT EXISTS sync_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;

-- Required config rows (values live only in the database, never in git):
--   base44_app_id, base44_api_key, sync_secret
