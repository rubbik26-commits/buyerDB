-- 001_schema.sql — Skyline Deal Intelligence canonical schema
-- Invariants encoded here (not just in code):
--   * no_residential CHECK: condos / co-ops / single-family / 1-2 family can never enter deals
--   * acris_requires_gate CHECK: an ACRIS-sourced party row cannot exist unless the amount gate passed
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ═══ CANONICAL DIMENSIONS ═══════════════════════════════════════
CREATE TABLE properties (
  property_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_raw   text NOT NULL,
  address_norm  text NOT NULL,
  street_number text,
  street_name_canon text,
  borough       text CHECK (borough IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')),
  market        text,
  zip           text,
  bbl           char(10),
  units int, sqft int, year_built int, bldg_class text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (address_norm, borough)
);

CREATE TABLE entities (
  entity_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  norm_name    text NOT NULL,
  entity_type  text CHECK (entity_type IN ('llc','individual','fund','corp','trust','gov','unknown')) DEFAULT 'unknown',
  is_spv_suspect boolean DEFAULT false,
  mailing_address text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX entities_norm_uq ON entities (norm_name);
CREATE INDEX entities_trgm ON entities USING gin (norm_name gin_trgm_ops);

CREATE TABLE entity_aliases (
  alias_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES entities NOT NULL,
  alias_norm text NOT NULL UNIQUE,
  source text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ═══ FACTS ══════════════════════════════════════════════════════
CREATE TABLE deals (
  deal_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid REFERENCES properties NOT NULL,
  sale_date    date,
  post_date    date,
  asset_type   text,
  sale_price   numeric(14,2),
  units int,
  sqft  int,
  ppu  numeric(12,2) GENERATED ALWAYS AS (CASE WHEN units > 0 AND sale_price IS NOT NULL THEN round(sale_price/units,2) END) STORED,
  ppsf numeric(12,2) GENERATED ALWAYS AS (CASE WHEN sqft  > 0 AND sale_price IS NOT NULL THEN round(sale_price/sqft,2)  END) STORED,
  source_system text CHECK (source_system IN ('acris','traded','crexi','instagram','upload','other')),
  source_url   text,
  shortcode    text UNIQUE,
  acris_doc_id text UNIQUE,
  confidence   int CHECK (confidence BETWEEN 0 AND 100),
  parse_status text CHECK (parse_status IN ('ok','needs_review')) DEFAULT 'ok',
  notes        text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT no_residential CHECK (asset_type IS NULL OR asset_type NOT IN
    ('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family'))
);
CREATE INDEX deals_sale_date ON deals (sale_date DESC);
CREATE INDEX deals_asset ON deals (asset_type);
CREATE UNIQUE INDEX deals_addr_price_date ON deals (property_id, sale_price, sale_date);

CREATE TABLE deal_parties (
  deal_id   uuid REFERENCES deals ON DELETE CASCADE NOT NULL,
  entity_id uuid REFERENCES entities NOT NULL,
  role      text CHECK (role IN ('buyer','seller','lender','borrower','landlord','tenant')) NOT NULL,
  mailing_address text,
  source_system text NOT NULL,
  provenance_ref text,
  amount_gate_passed boolean,
  verified_deed_amount numeric(14,2),
  match_confidence int,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (deal_id, entity_id, role),
  CONSTRAINT acris_requires_gate CHECK (source_system <> 'acris' OR amount_gate_passed IS TRUE)
);
CREATE INDEX deal_parties_entity ON deal_parties (entity_id, role);

-- ═══ USER-UPLOADED CRM LAYER ════════════════════════════════════
CREATE TABLE contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid REFERENCES entities NOT NULL,
  person_name text, title text,
  phone text, email text, mailing_address text,
  source text NOT NULL,
  confidence int DEFAULT 100,
  is_primary boolean DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX contacts_entity ON contacts (entity_id);

CREATE TABLE interactions (
  interaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES entities NOT NULL,
  contact_id uuid REFERENCES contacts,
  user_id text NOT NULL,
  channel text CHECK (channel IN ('call','email','text','meeting','mail','other')),
  occurred_at timestamptz NOT NULL,
  subject text, notes text, outcome text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX interactions_entity_time ON interactions (entity_id, occurred_at DESC);

CREATE TABLE uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  filename text,
  storage_path text,
  row_count int,
  column_mapping jsonb,
  status text CHECK (status IN ('staged','mapped','resolving','imported','failed')) DEFAULT 'staged',
  created_at timestamptz DEFAULT now()
);
CREATE TABLE upload_rows (
  upload_id uuid REFERENCES uploads ON DELETE CASCADE NOT NULL,
  row_num int NOT NULL,
  raw jsonb NOT NULL,
  resolution jsonb,
  status text CHECK (status IN ('pending','auto_matched','needs_review','imported','rejected')) DEFAULT 'pending',
  PRIMARY KEY (upload_id, row_num)
);

CREATE TABLE review_queue (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  object_id text NOT NULL,
  issue_class text NOT NULL,
  severity text DEFAULT 'normal',
  payload jsonb,
  status text CHECK (status IN ('open','resolved','dismissed')) DEFAULT 'open',
  resolved_by text, resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ═══ LEDGERS (pkl → tables, same semantics) ═════════════════════
CREATE TABLE fetch_ledger (
  url text PRIMARY KEY,
  disposition text NOT NULL,
  fetched_at timestamptz DEFAULT now()
);
CREATE TABLE exclusion_ledger (
  addr_norm text NOT NULL,
  price bigint NOT NULL,
  reason text NOT NULL,
  evidence text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (addr_norm, price)
);
CREATE TABLE rolling_ledger (
  deal_id uuid PRIMARY KEY REFERENCES deals ON DELETE CASCADE,
  processed_at timestamptz DEFAULT now()
);

-- ═══ OPS ════════════════════════════════════════════════════════
CREATE TABLE scrape_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  status text,
  stats jsonb,
  error text
);
CREATE TABLE ai_logs (
  log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text, provider text, model text, purpose text,
  latency_ms int, input_tokens int, output_tokens int,
  fallback_from text, status text,
  created_at timestamptz DEFAULT now()
);

COMMIT;
