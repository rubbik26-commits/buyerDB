-- 003: enable RLS on every Skyline table with NO policies. On Supabase this blocks
-- the auto-generated REST/GraphQL API (anon/authenticated roles) from reading deal
-- and contact data. The FastAPI backend and the worker connect over the direct
-- Postgres connection as the table owner, which RLS does not restrict (no FORCE),
-- so the application is unaffected. On plain Postgres this is a harmless no-op
-- for the owning role.
ALTER TABLE properties       ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_parties     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_rows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fetch_ledger     ENABLE ROW LEVEL SECURITY;
ALTER TABLE exclusion_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE rolling_ledger   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_logs          ENABLE ROW LEVEL SECURITY;
