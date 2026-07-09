-- 001b_sbi_base_schema.sql
-- Base sbi_* schema required by production RPC mode, Netlify functions, and sbi CSV loader.
-- Ordered before 002_workflow_os.sql.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION sbi_norm_address(input text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(trim(regexp_replace(regexp_replace(upper(coalesce(input,'')), '[^A-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

CREATE OR REPLACE FUNCTION sbi_norm_entity(input text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(trim(regexp_replace(regexp_replace(upper(coalesce(input,'')), '[^A-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

CREATE TABLE IF NOT EXISTS sbi_properties (
  property_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_raw text NOT NULL,
  address_norm text GENERATED ALWAYS AS (sbi_norm_address(address_raw)) STORED,
  street_number text,
  street_name_canon text,
  borough text,
  neighborhood text,
  market text,
  zip text,
  bbl char(10),
  block text,
  lot text,
  tax_class text,
  building_class text,
  zoning text,
  lot_area integer,
  building_area integer,
  residential_units integer,
  commercial_units integer,
  total_units integer,
  year_built integer,
  latitude numeric,
  longitude numeric,
  current_owner text,
  current_owner_norm text GENERATED ALWAYS AS (sbi_norm_entity(current_owner)) STORED,
  current_owner_mailing_address text,
  owner_status text DEFAULT 'unverified',
  owner_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification_status text DEFAULT 'unverified',
  record_quality text DEFAULT 'ok',
  source text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(address_norm, borough)
);

CREATE TABLE IF NOT EXISTS sbi_entities (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  norm_name text GENERATED ALWAYS AS (sbi_norm_entity(display_name)) STORED,
  entity_type text DEFAULT 'unknown',
  is_spv_suspect boolean DEFAULT false,
  mailing_address text,
  website text,
  key_person text,
  enrichment_status text DEFAULT 'not_started',
  enrichment_confidence integer,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(norm_name)
);

CREATE TABLE IF NOT EXISTS sbi_deals (
  deal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES sbi_properties(property_id) ON DELETE CASCADE,
  sale_date date,
  post_date timestamptz,
  asset_type text,
  transaction_type text DEFAULT 'sale',
  sale_price numeric,
  units integer,
  sqft integer,
  ppu numeric GENERATED ALWAYS AS (CASE WHEN units > 0 AND sale_price IS NOT NULL THEN round(sale_price / units::numeric, 2) ELSE NULL::numeric END) STORED,
  ppsf numeric GENERATED ALWAYS AS (CASE WHEN sqft > 0 AND sale_price IS NOT NULL THEN round(sale_price / sqft::numeric, 2) ELSE NULL::numeric END) STORED,
  source_system text,
  source_url text,
  source_urls text[],
  shortcode text,
  acris_doc_id text,
  confidence integer,
  parse_status text DEFAULT 'ok',
  verification_status text DEFAULT 'unverified',
  record_quality text DEFAULT 'ok',
  notes text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  source_key text,
  UNIQUE(property_id, sale_price, sale_date),
  UNIQUE(acris_doc_id),
  UNIQUE(shortcode)
);

CREATE TABLE IF NOT EXISTS sbi_deal_parties (
  deal_id uuid NOT NULL REFERENCES sbi_deals(deal_id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES sbi_entities(entity_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('buyer','seller','lender','broker','other')),
  mailing_address text,
  source_system text NOT NULL,
  provenance_ref text,
  amount_gate_passed boolean,
  verified_deed_amount numeric,
  match_confidence integer,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (deal_id, entity_id, role, source_system)
);

CREATE TABLE IF NOT EXISTS sbi_contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES sbi_entities(entity_id) ON DELETE CASCADE,
  person_name text,
  company text,
  title text,
  role text,
  phone text,
  email text,
  website text,
  linkedin text,
  mailing_address text,
  source text NOT NULL,
  confidence integer DEFAULT 100,
  is_primary boolean DEFAULT false,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sbi_review_queue (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  object_id text NOT NULL,
  issue_class text NOT NULL,
  severity text DEFAULT 'normal',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text DEFAULT 'open',
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sbi_source_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  job text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','completed_with_errors','failed','quota_blocked','timeout','cancelled','partial_success')),
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text
);

CREATE TABLE IF NOT EXISTS sbi_fetch_ledger (
  source text NOT NULL,
  source_key text NOT NULL,
  disposition text NOT NULL,
  fetched_at timestamptz DEFAULT now(),
  payload_hash text,
  PRIMARY KEY(source, source_key)
);

CREATE TABLE IF NOT EXISTS sbi_exclusion_ledger (
  exclusion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  addr_norm text,
  bbl char(10),
  price numeric,
  reason text NOT NULL,
  evidence text,
  source text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(addr_norm, price, reason)
);

CREATE TABLE IF NOT EXISTS sbi_entity_aliases (
  alias_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES sbi_entities(entity_id) ON DELETE CASCADE,
  alias_raw text NOT NULL,
  alias_norm text GENERATED ALWAYS AS (sbi_norm_entity(alias_raw)) STORED,
  source text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(entity_id, alias_norm, source)
);

CREATE TABLE IF NOT EXISTS sbi_interactions (
  interaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES sbi_entities(entity_id) ON DELETE CASCADE,
  contact_id uuid REFERENCES sbi_contacts(contact_id) ON DELETE SET NULL,
  channel text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  subject text,
  notes text,
  outcome text,
  user_id text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sbi_deals_sale_date_idx ON sbi_deals(sale_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS sbi_deals_asset_type_idx ON sbi_deals(asset_type);
CREATE INDEX IF NOT EXISTS sbi_properties_borough_idx ON sbi_properties(borough);
CREATE INDEX IF NOT EXISTS sbi_parties_entity_idx ON sbi_deal_parties(entity_id);
CREATE INDEX IF NOT EXISTS sbi_contacts_entity_idx ON sbi_contacts(entity_id);
CREATE INDEX IF NOT EXISTS sbi_review_status_idx ON sbi_review_queue(status, created_at DESC);
CREATE INDEX IF NOT EXISTS sbi_source_runs_started_idx ON sbi_source_runs(started_at DESC);

COMMIT;
