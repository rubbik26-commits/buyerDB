-- 004_sbi_worker_runtime_tables.sql
BEGIN;

CREATE TABLE IF NOT EXISTS sbi_rolling_ledger (
  deal_id uuid PRIMARY KEY REFERENCES sbi_deals(deal_id) ON DELETE CASCADE,
  processed_at timestamptz DEFAULT now()
);

COMMIT;
