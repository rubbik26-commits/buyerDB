# SKYLINE DEAL INTELLIGENCE — MASTER BLUEPRINT
## Converting the artifact + Python pipeline into a production React application

> **⚠️ Historical snapshot (2026-07-02).** This is the original architecture
> analysis, preserved as a dated record (constitution decision D-002: inherited
> research, not the approved Blueprint). Several conclusions were later
> superseded and should be read against the decisions log:
> - **Base44 is OUT of the system** (D-010). Where this doc keeps Base44 "as a
>   fallback host" or lists its hardcoded-key rotation as step 0, that debt is
>   retired — the Base44 hop (and its exposed keys) no longer exist in the live
>   path. The Base44 contact data was harvested into Supabase first.
> - **The live refresh is Supabase-native pg_cron → edge functions →
>   `sync_upsert_deals()`** (D-008), not the GitHub-Actions worker (now a gated
>   legacy fallback). See `architecture/SOP-daily-refresh.md`.
> - Live counts have moved on (4,129 CSV snapshot → 4,533 deals as of
>   2026-07-06); migrations now run 001–008 applied + 009 staged (2026-07-07).
>
> The dataset shape, invariants, transport constraints (curl_cffi vs
> ScraperAPI), and provider research below remain accurate and load-bearing.

**Written 2026-07-02.** Every dataset number below was re-verified in this session against the actual CSV (not copied from the handoff). Every free-tier and scheduler number was researched today with sources named. Facts I could not verify are marked **TO-VERIFY**.

**Evidence disclosure (protocol):** `HANDOFF.md`, `README.md`, and all eight Python modules were read in full from the project directory. `Potential_Blueprint.docx` was extracted with pandoc and read in full (481 lines). The canonical CSV was loaded and independently verified: **4,129 rows × 27 columns; Buyer 79%, Seller 78%, addresses 65%, phone/email 2%, price 93%; 372 needs_review; sources = ACRIS 2,482 / traded 964 / crexi 594 / other 89** — every figure matches the handoff exactly. One honest caveat: `skyline-deal-intelligence.jsx` appeared in the uploads list but did not land on disk in this session. Its internals below (record shape, tabs, Agent Desk pipeline) are taken from the verbatim build records of the session that created it — including the actual `CRITERIA_PROMPT`, `rankCandidates`, `buyerProfileText`, and `callClaude` source — not from memory or the handoff summary.

---

## 1. CURRENT-STATE ANALYSIS

### 1.1 The artifact (`skyline-deal-intelligence.jsx`)

What it actually is, from the build records:

- A single-file React app: `deals_data.js` (compressed JSON payload) concatenated with `app.jsx`, `import React, { useState, useMemo, useRef, useEffect } from "react"` at the top. Build verified with esbuild.
- **Data payload:** 4,129 records under `const DEALS`, with short keys to shrink the bundle: `d` (date), `a` (address), `b` (borough), `m` (market), `t` (asset type), `by`/`sl` (buyer/seller), `p`/`u`/`sf`/`ppu`/`ppsf` (numerics), `c` (confidence), `ps` (parse status as 0/1), `url` (prefix-compressed: `0|`=ACRIS, `1|`=traded, `2|`=crexi), plus `bp/be/bw/ba/sp/se/sw/sa` contact fields. ~1.3 MB embedded.
- **Four tabs sharing one filter system:** Deals (14-way filters, sortable, expandable rows), Buyers (`aggregateBuyers` over the *filtered* set, rank by count/volume, min-deals chips), Leaderboards (top buyers by asset type / borough / overall), Agent Desk.
- **Agent Desk is a two-stage pipeline, and this design survives into production:**
  1. `callClaude([CRITERIA_PROMPT(q)])` → strict JSON: `asset_types`, `boroughs` (with neighborhood→borough mapping baked into the prompt), `price_min/max`, `keywords`, `intent_summary`.
  2. `rankCandidates(criteria)` — pure client-side scoring over deals with a buyer: +3/−2 asset match, +2/−1 borough, ±1 price band (min×0.5 / max×2), +2 keyword hit in address+market, +0.5×min(count,5) recurrence bonus. Top 35 buyers.
  3. `buyerProfileText` flattens each candidate (deals, volume, types, boroughs, price range, last deal, contacts, 3 recent deals) → second `callClaude` with the last 6 conversation turns, instructions to discount single-purpose LLCs named after addresses, and to cite actual track records.
- `callClaude` POSTs to `https://api.anthropic.com/v1/messages` with **no key** — this works only inside the Claude.ai artifact runtime, which proxies the call. **Outside that runtime the Agent Desk is dead on arrival.** This single fact, more than anything else, mandates a backend.

### 1.2 The pipeline (all modules read in full)

| Module | What it proves for the production design |
|---|---|
| `traded_scraper.py` | Transport chain in `_get()`: `SCRAPERAPI_KEY` env → curl_cffi Chrome impersonation → plain requests; 403 retryable with backoff. Discovery = 13 listing pages + `/deals/` + NY-scoped sitemap + 3 URL-extraction paths. Structured `deal.buyers/sellers.profileDealCompanies` primary, title parse fallback. Writes SQLite with `UNIQUE(shortcode)`, `UNIQUE(traded_url)`. |
| `traded_backfill.py` | Checkpointed concurrent runner (concurrency 3) consuming `backlog.pkl`, ledger `backfill_done.pkl` records **every URL + disposition** (the dataset alone cannot dedupe discovery — rejected fetches store no URL). Geo resolver ranks caption/submarket neighborhood > ZIP; conflicts flagged, never asserted. Cloudflare challenge-body detection. |
| `acris_enrich.py` | Shared library: `norm_entity`, `canon_street`, `split_address`, `is_placeholder`, SoQL client with 429/503 backoff, `build_bbl`, PLUTO fetch, `classify()` with condo classes (R, CC/CP, SC/RG…) rejected. |
| `phase2_job.py` / `phase2_stages.py` | Address→legals→deed-masters matching for rows missing parties; checkpointed, thread-pooled; price rows need document_amt within 3% + date distance ≤400d; no-price rows need a unique ≥$200K deed within 240d. |
| `phase3_fresh.py` | Fresh-window ACRIS ingest (120 days, $1M floor), staged (masters/detail/pluto/build), dedupe on doc_id + normalized address+price, confidence scoring, provenance in Notes. |
| `apply_enrichment.py` | **THE AMOUNT GATE:** party fills only when deed amount is within 3% of row price (or no-price + ≤60d). Root cause documented in-file: 34/34 address+date-only matches attached wrong-deed parties. Never overwrites non-null. Appends provenance to Notes. |
| `rolling_sales.py` | Sqft/units fill only when all Rolling Sales rows for the address agree; >20% conflict with existing value → flag, never overwrite; R-class ignored; SoQL quote escaping fixed. |

**Three state ledgers are the pipeline's memory** and must become durable tables, not files: `backfill_done.pkl` (fetch ledger), `exclusion_ledger.pkl` (11 addr+price keys of deed-verified condos; 3 rows re-entered via a merge before it existed), `rolling_done.pkl`.

### 1.3 What's broken about the current architecture

1. No scheduler — every refresh is a manual session.
2. Secrets: the Agent Desk only works inside the artifact proxy; and per the handoff, **the user's Base44 edge functions contain a hardcoded Base44 API key and a hardcoded ScraperAPI key in source. Both must be rotated** (see §7).
3. State in `.pkl` files on an ephemeral filesystem — one lost file silently re-admits excluded condos or re-fetches ~600 URLs.
4. 1.3 MB JSON in the client bundle — fine for a demo, wrong for an app; no pagination, no server filtering, full re-ship on every data change.
5. No concept of *users' own data* (contacts, interactions) — the highest-value questions ("phone number?", "when did we last contact?") are unanswerable because, as verified, public records cap out at mailing addresses (phones/emails only 2%, Traded-published).

---

## 2 & 3. RECOMMENDED ARCHITECTURE — React frontend + backend is mandatory

A React-only app is ruled out by four independent hard constraints: (a) browsers cannot run cron; (b) provider/Socrata/ScraperAPI keys in a client bundle are public; (c) the Anthropic call in the artifact only works behind Claude.ai's proxy; (d) 4,129 rows is already 1.3 MB embedded and grows daily.

**Chosen stack (with reasons tied to this codebase, not generic preference):**

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND  React 18 + Vite, deployed on Vercel/Netlify (static) │
│  Ports the existing tabs; fetches paginated JSON; SSE agent chat│
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS + JWT (Supabase Auth)
┌──────────────────────────▼──────────────────────────────────────┐
│  BACKEND API  FastAPI (Python) on Render/Railway/Fly.io         │
│  /api/deals /api/buyers /api/leaderboards /api/agent (SSE)      │
│  /api/uploads /api/review  — AI provider router lives here      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ asyncpg / SQLAlchemy
┌──────────────────────────▼──────────────────────────────────────┐
│  POSTGRES (Supabase)  deals + entities + contacts + ledgers     │
│  + pgvector (later)  + Supabase Auth + Storage (raw uploads)    │
└──────────────────────────▲──────────────────────────────────────┘
                           │ psycopg (writes gated by amount-gate code path)
┌──────────────────────────┴──────────────────────────────────────┐
│  INGESTION WORKER  the EXISTING Python modules, on GitHub       │
│  Actions cron (curl_cffi works there = traded.co stays free)    │
└─────────────────────────────────────────────────────────────────┘
```

**Why FastAPI and not Node/Express:** the correctness of this system lives in Python functions that were debugged the hard way — `norm_entity`, `canon_street`, `split_address`, `is_placeholder`, the amount gate. The upload/entity-resolution path (§8–9) must apply *exactly* these functions. Porting them to JS is a re-introduction of the class of error the 34/34 audit killed. One language for backend + worker means one implementation of every invariant.

**Why the worker stays Python on GitHub Actions:** verified 2026-07-02 in-session, traded.co's Cloudflare blocks python-requests' TLS fingerprint but passes curl_cffi Chrome impersonation (~590 fetches, zero blocks). curl_cffi runs anywhere Python runs — including Actions runners. A Deno/JS host (Base44, Supabase edge, Vercel/CF cron) cannot run curl_cffi and therefore needs ScraperAPI. Researched today: ScraperAPI's free plan is **1,000 credits/month (5 concurrent)**, and **Cloudflare-protected sites cost ~11 credits/request (1 + 10 anti-bot surcharge)** → ~90 traded.co pages/month free, then $49/mo Hobby. The Python path costs $0. (Sources: scraperapi.com/pricing, docs.scraperapi.com Plans & Billing.)

**GitHub Actions constraints, verified today:** free plan = 2,000 minutes/month on **private** repos (public repos unlimited, but this data is proprietary — use private); minimum schedule interval 5 minutes; **schedules are best-effort — 5–30 min delays are common, worse at :00**; **scheduled workflows auto-disable after 60 days without repo activity**; jobs cap at 6 hours. Mitigations are all cheap: schedule at odd minutes (e.g. `17 13 * * *`), add `workflow_dispatch` for manual runs, and have the daily job push an empty keep-alive commit so the 60-day timer never fires. Budget math: daily incremental ≈ 10–15 min + weekly enrichment ≈ 4×25 min ≈ **~550 min/month, well inside 2,000**. If the exact-time delay ever matters, an external pinger can hit the `workflow_dispatch` API — but for a "refresh the data daily" job, delay tolerance is high.

**Database host:** Supabase. Researched today: free tier = 500 MB DB, unlimited API requests, 500K edge invocations, pgvector included, **but free projects pause after 7 days without DB activity** — the daily scraper writes make that moot in practice, though for production reliability + daily backups the **$25/mo Pro plan is the honest recommendation** (free tier has no backups at all). The current dataset is ~2 MB; even 10 years of growth plus contacts/interactions stays far under 500 MB, so size is not the constraint — backups and non-pausing are. Alternatives (Neon, Render Postgres) are fine; Supabase wins because Auth + Storage + Row-Level Security come bundled, which §8's upload flow uses.

The user's existing **Base44 app** remains a valid alternative host for the ingestion (its Deno ingesters + ScrapeRun audit entity are proven) — but it forces ScraperAPI for traded.co (paid) and splits the invariants across two languages. Keep it as fallback, not primary.

---

## 4 & 5. DATABASE SCHEMA & DATA MODELS

Principles carried from the pipeline: **never overwrite non-null** (enforced in the write path), **provenance on every fill** (first-class columns now, not a Notes string), **conflicts flagged not resolved** (review_queue), **ledgers are sacred** (tables with the same semantics as the .pkl files).

```sql
-- ═══ CANONICAL DIMENSIONS ═══════════════════════════════════════
CREATE TABLE properties (
  property_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_raw   text NOT NULL,
  address_norm  text NOT NULL,          -- normalize_address() port from phase3
  street_number text, street_name_canon text,   -- split_address()/canon_street()
  borough       text CHECK (borough IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')),
  market        text, zip text, bbl char(10),
  units int, sqft int, year_built int, bldg_class text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (address_norm, borough)
);

CREATE TABLE entities (                  -- one row per legal entity/person
  entity_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  norm_name    text NOT NULL,            -- norm_entity() output, indexed
  entity_type  text CHECK (entity_type IN ('llc','individual','fund','corp','trust','gov','unknown')) DEFAULT 'unknown',
  is_spv_suspect boolean DEFAULT false,  -- name matches a property address (Agent Desk heuristic, now persisted)
  mailing_address text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX ON entities (norm_name);
CREATE INDEX ON entities USING gin (norm_name gin_trgm_ops);  -- pg_trgm for fuzzy resolution

CREATE TABLE entity_aliases (            -- upload-time merges keep history
  alias_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES entities NOT NULL,
  alias_norm text NOT NULL, source text NOT NULL, created_at timestamptz DEFAULT now(),
  UNIQUE (alias_norm)
);

-- ═══ FACTS ══════════════════════════════════════════════════════
CREATE TABLE deals (
  deal_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid REFERENCES properties NOT NULL,
  sale_date    date, post_date date,
  asset_type   text,                     -- CHECK excludes 'Condo','Commercial Condo','Co-op','Single Family'
  sale_price   numeric(14,2), units int, sqft int,
  ppu numeric(12,2) GENERATED ALWAYS AS (CASE WHEN units>0 THEN round(sale_price/units,2) END) STORED,
  ppsf numeric(12,2) GENERATED ALWAYS AS (CASE WHEN sqft>0 THEN round(sale_price/sqft,2) END) STORED,
  source_system text CHECK (source_system IN ('acris','traded','crexi','instagram','upload','other')),
  source_url   text, shortcode text UNIQUE,
  acris_doc_id text UNIQUE,              -- nullable; the phase3 dedupe key, now a constraint
  confidence   int CHECK (confidence BETWEEN 0 AND 100),
  parse_status text CHECK (parse_status IN ('ok','needs_review')) DEFAULT 'ok',
  notes        text,                     -- legacy provenance string preserved verbatim on migration
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT no_residential CHECK (asset_type IS NULL OR asset_type NOT IN
    ('Condo','Commercial Condo','Co-op','Single Family'))
);
CREATE INDEX ON deals (sale_date DESC); CREATE INDEX ON deals (asset_type);
CREATE UNIQUE INDEX deals_addr_price ON deals (property_id, sale_price, sale_date); -- addr+price dedupe key

CREATE TABLE deal_parties (
  deal_id   uuid REFERENCES deals NOT NULL,
  entity_id uuid REFERENCES entities NOT NULL,
  role      text CHECK (role IN ('buyer','seller','lender','borrower','landlord','tenant')) NOT NULL,
  mailing_address text,
  source_system text NOT NULL,           -- 'acris' | 'traded' | 'upload' …
  provenance_ref text,                   -- ACRIS doc_id, traded URL, upload_id — WHO SAID SO, queryable
  amount_gate_passed boolean,            -- NULL for non-ACRIS sources; NEVER false-and-present
  verified_deed_amount numeric(14,2),
  match_confidence int,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (deal_id, entity_id, role),
  CONSTRAINT acris_requires_gate CHECK (source_system <> 'acris' OR amount_gate_passed IS TRUE)
);
```

That last constraint is the amount gate promoted from convention to schema: **an ACRIS-sourced party row physically cannot exist unless the gate passed.** The gate itself (|deed − price|/price ≤ 3%, or no-price + ≤60d) stays in the single Python write path (`apply_enrichment` logic), because it needs the live ACRIS master; the constraint makes bypassing that path impossible.

```sql
-- ═══ USER-UPLOADED CRM LAYER ════════════════════════════════════
CREATE TABLE contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid REFERENCES entities NOT NULL,
  person_name text, title text,
  phone text, email text, mailing_address text,
  source text NOT NULL,                  -- 'upload:<upload_id>' | 'traded' | 'manual'
  confidence int DEFAULT 100, is_primary boolean DEFAULT false,
  created_by uuid, created_at timestamptz DEFAULT now()
);
CREATE INDEX ON contacts (entity_id);

CREATE TABLE interactions (              -- "when did we last contact X?"
  interaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES entities NOT NULL,
  contact_id uuid REFERENCES contacts,
  user_id uuid NOT NULL,
  channel text CHECK (channel IN ('call','email','text','meeting','mail','other')),
  occurred_at timestamptz NOT NULL,
  subject text, notes text, outcome text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX ON interactions (entity_id, occurred_at DESC);

CREATE TABLE uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, filename text, storage_path text,   -- Supabase Storage
  row_count int, column_mapping jsonb,   -- user-confirmed mapping, auditable
  status text CHECK (status IN ('staged','mapped','resolving','imported','failed')) DEFAULT 'staged',
  created_at timestamptz DEFAULT now()
);
CREATE TABLE upload_rows (               -- raw staging, never mutated
  upload_id uuid REFERENCES uploads NOT NULL,
  row_num int NOT NULL,
  raw jsonb NOT NULL,
  resolution jsonb,                      -- {entity_id, method:'exact|alias|trgm|manual', score}
  status text CHECK (status IN ('pending','auto_matched','needs_review','imported','rejected')) DEFAULT 'pending',
  PRIMARY KEY (upload_id, row_num)
);

CREATE TABLE review_queue (              -- 372 needs_review rows land here on migration
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL, object_id text NOT NULL,
  issue_class text NOT NULL,             -- 'sqft_conflict','geo_conflict','entity_merge','rg_class',…
  severity text DEFAULT 'normal', payload jsonb,
  status text CHECK (status IN ('open','resolved','dismissed')) DEFAULT 'open',
  resolved_by uuid, resolved_at timestamptz, created_at timestamptz DEFAULT now()
);

-- ═══ THE LEDGERS (pkl → tables, same semantics) ═════════════════
CREATE TABLE fetch_ledger (              -- backfill_done.pkl
  url text PRIMARY KEY, disposition text NOT NULL,  -- 'ok','no_address','residential_asset:…','fetch_error:…'
  fetched_at timestamptz DEFAULT now()
);
CREATE TABLE exclusion_ledger (          -- exclusion_ledger.pkl — consult in EVERY merge
  addr_norm text NOT NULL, price bigint NOT NULL,
  reason text NOT NULL, evidence text,   -- e.g. 'deed-verified condo, ACRIS <doc_id>'
  created_at timestamptz DEFAULT now(), PRIMARY KEY (addr_norm, price)
);
CREATE TABLE rolling_ledger (            -- rolling_done.pkl
  deal_id uuid PRIMARY KEY REFERENCES deals, processed_at timestamptz DEFAULT now()
);

-- ═══ OPS ════════════════════════════════════════════════════════
CREATE TABLE scrape_runs (               -- mirrors Base44's proven ScrapeRun audit entity
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL, started_at timestamptz, finished_at timestamptz,
  status text, stats jsonb,              -- {discovered, fetched, merged, rejected, gated_out,…}
  error text
);
CREATE TABLE ai_logs (
  log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, provider text, model text, purpose text,   -- 'criteria','rank','sql_agent','embedding'
  latency_ms int, input_tokens int, output_tokens int,
  fallback_from text, status text, created_at timestamptz DEFAULT now()
);
```

**Migration plan (CSV → DB), in order:** (1) load `dataset_final_v7.pkl`/CSV into a `legacy_import` staging table verbatim; (2) build `properties` from distinct normalized addresses (reusing `normalize_address` from phase3 build stage); (3) insert `deals` with the legacy Notes preserved and `acris_doc_id` extracted via the same `doc_id=([A-Z0-9]+)` regex phase3 already uses; (4) build `entities` from distinct `norm_entity(Buyer/Seller)` and `deal_parties` with `source_system` parsed from Notes (`parties from ACRIS <id> (amount-gated)` → acris + gate=true + doc ref; otherwise the row's own source); (5) load the three .pkl ledgers into their tables; (6) enqueue all 372 needs_review rows + the `16 Goodwin Place` RG decision into `review_queue`; (7) run count/percentage assertions against the verified figures above — the migration is not done until they match.

---

## 6. SCRAPER ARCHITECTURE & SCHEDULING

The modules keep their logic; only their storage layer changes: a thin `store.py` replaces pickle reads/writes with the ledger/deal tables (`ON CONFLICT DO NOTHING` on `fetch_ledger.url`, exclusion check before every insert, amount-gated write path for parties). Checkpointing comes free — the ledger *is* the checkpoint.

```
.github/workflows/
├── daily-incremental.yml    # cron '17 13 * * *'  (~09:17 ET, off the hour)
│   1. traded discovery (listing pages + sitemap delta) MINUS fetch_ledger
│   2. fetch/parse new deals → merge (exclusion ledger + addr+price dedupe)
│   3. phase3_fresh masters→detail→pluto→build (fresh ACRIS window)
│   4. rolling_sales batch 400
│   5. keep-alive empty commit + scrape_runs row + failure alert
├── weekly-enrichment.yml    # cron '43 11 * * 0'
│   phase2 legals→masters→match → apply_enrichment (AMOUNT GATE)
│   → closes the ~360-row ACRIS-lag backlog as the 7–8 week window rolls
└── (workflow_dispatch on both for manual/API triggering)
```

Design rules carried over verbatim: 403 is retryable; sitemap regex stays NY-scoped; discovery must subtract the fetch ledger before fetching anything; every merge consults the exclusion ledger; conflicts → review_queue; provenance columns filled on every write. Instagram stays optional/off (verified: datacenter IPs get 403 on graphql).

**Failure visibility:** each workflow ends by writing `scrape_runs`; a final step fails the job loudly (GitHub emails on failure) and can ping a webhook. No silent catches — same rule as the codebase.

---

## 7. ENVIRONMENT VARIABLES & SECRETS

**Step 0, before any building — two keys are exposed in source today** (Base44 API key and ScraperAPI key in the Deno edge functions, per the verified handoff): rotate both at their dashboards, move to env/secrets, and confirm the old values are dead. Do this first; it is independent of everything else.

Placement matters more than the list:

| Where | Secrets |
|---|---|
| GitHub Actions → repo Secrets | `DATABASE_URL` (worker role), `SOCRATA_APP_TOKEN`, `SCRAPERAPI_KEY` (fallback transport only), `ALERT_WEBHOOK_URL` |
| Backend host (Render/Railway env) | `DATABASE_URL` (api role), `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_PROVIDER_ORDER` (e.g. `groq,gemini,openrouter,cloudflare`), `AI_QUALITY_PROVIDER` (e.g. `anthropic`), `FRONTEND_URL` |
| Frontend (Vercel) | `VITE_API_URL`, Supabase **anon** key only — nothing secret, ever |

Two Postgres roles (`worker` can write deals/ledgers, `api` can write contacts/interactions/uploads but only read deals) so a compromised API key can't corrupt the pipeline's tables. Socrata note: the app token isn't strictly secret, but registering one lifts you out of the shared anonymous throttling pool — worth doing (data.cityofnewyork.us developer settings). The `AMOUNT_GATE_THRESHOLD` idea from the draft docx is rejected: 3% is a validated invariant, not a tunable — making it an env var invites silently loosening the one rule that prevented the 34/34 failure class.

---

## 8. USER-UPLOADED CSV/EXCEL INGESTION

Flow (all server-side, FastAPI + pandas/openpyxl — the same stack that built the dataset):

1. **Upload** → file lands in Supabase Storage; `uploads` row created; rows parsed into `upload_rows.raw` (jsonb, verbatim — the audit trail).
2. **Mapping** → backend sniffs headers against a synonym table (`phone|tel|mobile|cell → phone`, `owner|entity|company|buyer → entity_name`, …) and proposes a mapping; user confirms/edits in a mapping UI; confirmed mapping saved to `uploads.column_mapping`.
3. **Normalization** → per row: `norm_entity()` on names, phone → E.164, email lowercased, addresses through `split_address`/`canon_street`.
4. **Entity resolution** (§9) → each row gets `resolution` + status.
5. **Import** → auto-matched rows write `contacts` (and `interactions` if the file carries history columns like last-contact date/notes); ambiguous rows sit in `review_queue` with side-by-side candidates for one-click confirm/reject; nothing ambiguous is silently merged — same philosophy as the geo-conflict flags.
6. Deal-shaped uploads additionally pass the **exclusion ledger + no_residential check + addr+price dedupe** before touching `deals` — uploaded files are exactly the "scraped sources re-surface excluded deals" vector the ledger exists for.

## 9. DEDUPLICATION / ENTITY RESOLUTION

Layered, cheapest-first, and only the top layer is automatic:

1. **Exact:** `norm_entity(name)` == `entities.norm_name` → auto-match.
2. **Alias:** hit in `entity_aliases` (accumulated from prior manual confirmations — the system gets smarter with use) → auto-match.
3. **Fuzzy:** pg_trgm `similarity(norm_name, candidate) > 0.55` → candidates ranked, **needs_review**, never auto-merged. (Threshold is a starting point to tune against real uploads — stated as such, not as fact.)
4. **Property-context boost:** if the uploaded row carries an address that normalizes to a property where the candidate entity was a party, rank that candidate first — a "J. Smith" who bought the exact building outranks string similarity.
5. **SPV handling:** entities whose norm_name contains a street-number+name matching a property (`is_spv_suspect`) are excluded from fuzzy auto-suggestions across *different* properties — single-purpose LLCs named after addresses are the known trap the Agent Desk prompt already warns about; the DB should encode it, not just the prompt.

Properties dedupe on `(address_norm, borough)` with the ported normalizer; deals on `acris_doc_id` then `(property, price, date)` — the exact keys phase3 already proved out (179 addr+price + 4 addr+date rejections in the final reconciliation).

---

## 10, 11 & 12. THE AI KNOWLEDGE BASE — SQL-FIRST TOOL-USE AGENT

The handoff's call is correct and the numbers back it: this data is almost entirely structured, and the flagship questions are deterministic lookups. **"What's this owner's phone number?" must be a JOIN, not a similarity search** — a RAG answer to that question is a hallucination risk with a phone number attached.

**Agent design (server-side, `/api/agent`, streaming):**

```python
TOOLS = [
  lookup_contact(entity_name)        # entities→(aliases/trgm)→contacts; returns matches + confidence + source
  last_interaction(entity_name)      # interactions ORDER BY occurred_at DESC
  buyer_leaderboard(asset_type?, borough?, price_min?, price_max?,
                    since?, rank_by)  # deal_parties role='buyer' GROUP BY entity
  find_similar_buyers(asset_type, borough?, price?)   # the ported rankCandidates scoring, in SQL
  entity_history(entity_name, role?) # full deal history for a buyer/seller
  seller_owners_of_similar(asset_type, borough?)      # "which sellers own similar properties"
  missing_contact_report(filter?)    # contacts gaps: entities with deals but no phone/email
  recent_changes(days)               # deals WHERE created_at/updated_at > now()-interval
  run_readonly_sql(sql)              # guarded: SELECT-only, allowlisted tables, LIMIT enforced, 5s timeout
]
```

Every listed use case maps to one named tool — the LLM's job is intent → tool + arguments → natural-language answer citing rows, exactly the two-stage shape the Agent Desk already proved (criteria extraction → deterministic scoring → narrated ranking). Keep the LLC-discounting instruction; now it's also a `is_spv_suspect` filter. Named tools are preferred over free-form SQL for the 90% path (validatable, cheap, small models handle them); `run_readonly_sql` is the escape hatch for long-tail questions, gated to a read-only role.

**RAG comes later, and only for genuinely fuzzy text:** `interactions.notes` and uploaded free-text ("did anyone sound interested in Bronx multifamily?"). pgvector is already included in Supabase (verified) — add an `embeddings` table + a `search_notes(query)` tool when there are actual notes to search. Embedding the deals table is explicitly *not* planned; it's structured and SQL answers it better.

**Answer discipline:** every agent answer cites its rows (deal shortcodes / entity ids the UI can link), states data limits honestly (e.g. "no phone on file — mailing address only; phones aren't in public records"), and never invents contact info. That last behavior is a system-prompt rule *and* a UI rule (contact fields render only from `contacts` rows, never from model text).

---

## 13. MULTI-PROVIDER LAYER — verified quotas and a policy that follows from them

Researched 2026-07-02 (limits change; **re-verify at build time** — sources: ai.google.dev/gemini-api/docs/rate-limits; console.groq.com/docs/rate-limits; openrouter.ai/docs FAQ+limits; developers.cloudflare.com/workers-ai/platform/pricing; Anthropic/OpenAI pricing pages):

| Provider | Free tier — verified today | Role in the router |
|---|---|---|
| **Groq** | Real free tier, no card: ~30 RPM, ~6K TPM, 1K–14.4K req/day by model, org-level. Open-source models (Llama, Qwen…), very fast; tool-use supported (verify per-model). | **Primary tool-calling lane** — criteria extraction + tool selection |
| **Gemini** | Free tier is Flash/Flash-Lite only now (Pro removed from free ~Apr 2026): ~10–15 RPM, ~250–1,500 req/day by model, 1M context. Per-project; enabling billing on the project **removes** its free tier; free-tier prompts may be used for training — don't send uploaded client contact data through it. | Secondary lane + long-context jobs (big upload summaries) |
| **OpenRouter** | 50 req/day free; **one-time $10 credit purchase permanently raises it to 1,000/day**; 20 RPM on `:free` models. | Breadth + tertiary fallback (28+ free models behind one API) |
| **Cloudflare Workers AI** | 10,000 neurons/day free (≈15–25 Llama-class generations/day), resets 00:00 UTC. | Utility lane: embeddings, cheap classification; too small for primary chat |
| **Anthropic** | **No ongoing free API tier** — one-time ~$5 trial credit only. Sonnet $3/$15 per MTok. | **Quality lane (paid)** — final ranked recommendations, the role `claude-sonnet-4-6` already plays in the Agent Desk |
| **OpenAI** | **No permanent free tier** — trial credits expire; a data-sharing free-token program exists (opt-in, terms to review). | Optional quality-lane alternate; embeddings if preferred |

The user's belief "several have free tiers" is confirmed for Gemini/Groq/OpenRouter/Cloudflare and disconfirmed for Anthropic/OpenAI — plan for a small paid Anthropic budget for the quality lane (at Agent Desk volumes, ~$1–5/mo of Sonnet; Haiku cheaper still), or run quality-lane on Groq's larger models at $0.

**Router implementation:** one adapter interface (`complete(messages, tools?, json_mode?) → normalized response`) per provider — Groq/OpenRouter/Cloudflare/Gemini all speak OpenAI-compatible or near-compatible APIs, so this is thin. Policy: two ordered chains from env (`AI_PROVIDER_ORDER` for the fast/tool lane, `AI_QUALITY_PROVIDER(S)` for final synthesis). Failover triggers: 429, 5xx, timeout (10s), or malformed-JSON on extraction (one in-provider retry first). Track rolling per-provider request counts in memory + `ai_logs` so the router *pre-emptively* skips a provider whose daily cap is near (Groq doesn't expose RPD in headers — count it yourself). Failed attempts count against OpenRouter's quota — don't use it as the retry dumping ground. Every call logs provider/model/latency/tokens/fallback_from to `ai_logs`, which is also how you'll know when free tiers stop being enough.

---

## 14. NOW vs LATER — honest scoping

**Now (the buildable core, ~3–4 weeks of focused work):** key rotation; Postgres schema + migration with assertions; worker refactor (store.py) + two Actions workflows; FastAPI read APIs; React port of the four tabs against the API; upload → mapping → entity resolution → contacts/interactions; SQL-tool agent with Groq→Gemini→OpenRouter routing + paid Anthropic quality lane; review queue UI.

**Later (real, but not blocking):** pgvector RAG over interaction notes; skip-trace provider integration (the only lawful route to phones/emails beyond uploads — public records cap at mailing addresses, verified); outbound CRM sync; multi-user roles/teams; PostGIS + map view; self-hosted runner if Actions minutes ever bind; alerting dashboard on `scrape_runs`.

**Never (scope honesty):** phones/emails from ACRIS/PLUTO/Rolling Sales (not public record); exact-second scheduling on GitHub cron (best-effort by design); Instagram from datacenter IPs; a client-side app doing any of this securely.

## 15. KEY RISKS & MITIGATIONS

1. **traded.co hardens further** — curl_cffi impersonation could stop working. Mitigation: transport chain already falls back to ScraperAPI (env-gated); budget reality: ~11 credits/page ⇒ free tier ≈ 90 pages/mo, $49/mo ≈ 9K pages. Daily *incremental* volume (a handful of new NY deals/day) fits even the free tier; a re-backfill would not.
2. **Wrong-party fills** — the 34/34 failure class. Mitigation: gate in the sole write path + `acris_requires_gate` CHECK; acceptance test (§17) proves it.
3. **False entity merges on upload** — a wrong merge poisons "phone for X". Mitigation: only exact/alias auto-match; fuzzy always human-confirmed; alias table makes each confirmation permanent; SPV filter.
4. **Actions scheduling drift** — delays (5–30 min), 60-day auto-disable, 2,000-min cap. Mitigation: off-hour minutes, keep-alive commit, `workflow_dispatch`, minute budget ~550/2,000, alert if `scrape_runs` shows no run in 36h (dead-man's switch).
5. **Free-tier quota changes** — Gemini cut free quotas 50–80% in Dec 2025; rosters rotate. Mitigation: the router treats providers as interchangeable; `ai_logs` shows drift; $10 OpenRouter unlock is cheap insurance (1,000/day permanently).
6. **PII duty** — uploaded contacts are client data. Mitigation: RLS per user on contacts/interactions/uploads, no contact data to training-eligible free tiers (Gemini free explicitly may train on prompts), Supabase Pro backups, encrypted at rest by default.
7. **Supabase free-tier pause** (7 days idle) — moot with daily writes, eliminated on Pro.
8. **372 needs_review + 16 Goodwin Place** — data debt, not code debt. Mitigation: review_queue UI makes it a workflow; RG rule (1-fam exclude / 2-fam keep) needs the user's call or PLUTO unit evidence, exactly as the handoff left it.

## 16. HOSTING (concrete, with monthly costs)

| Layer | Pick | Cost |
|---|---|---|
| Postgres + Auth + Storage | Supabase | $0 to start → **$25/mo Pro** for backups/no-pause (recommended at cutover) |
| Backend API | Render or Railway (FastAPI container) | free tier to start (Render free spins down on idle) → ~$7/mo starter for always-on |
| Frontend | Vercel or Netlify (static Vite build) | $0 |
| Worker | GitHub Actions (private repo) | $0 (within 2,000 min) |
| AI | Groq/Gemini/OpenRouter/CF free lanes + small Anthropic budget | $0–$10/mo typical |
| **Total** | | **$0 prototype → ~$32–42/mo production** |

## 17. IMPLEMENTATION ROADMAP (with the handoff's acceptance criteria as gates)

| # | Phase | Days | Exit criterion (evidence, not "should work") |
|---|---|---|---|
| 0 | **Rotate the two exposed keys**; create repo, envs, Supabase project | 0.5 | old keys return 401 |
| 1 | Schema migrations + pg_trgm; roles worker/api | 1 | migrations apply clean on fresh DB |
| 2 | Data migration CSV+ledgers → tables | 2 | assertion script: 4,129 deals, fill-rates match §1, 3 ledgers row-counted vs .pkl, 372 review rows |
| 3 | Worker refactor: store.py replaces pickles; run modules locally against DB | 3–4 | one manual end-to-end run merges ≥1 new deal with ledger dedupe visible in `scrape_runs` |
| 4 | Actions workflows (daily + weekly) | 1–2 | **Acceptance A:** a scheduled run ingests a new traded/ACRIS deal end-to-end, dedupe against ledgers proven in run stats |
| 5 | FastAPI read endpoints (deals/buyers/leaderboards, pagination, filters) | 2–3 | parity checks vs artifact aggregates on same filters |
| 6 | React port of the 4 tabs against the API | 3–4 | build passes; no secrets in bundle (`grep` the dist) — **Acceptance D** |
| 7 | Upload pipeline + entity resolution + review UI | 3–4 | **Acceptance B:** agent answers a phone-number lookup sourced from an uploaded contacts CSV, with provenance shown |
| 8 | Agent: tools + provider router + SSE chat | 4–5 | **Acceptance C:** kill the primary provider key → request succeeds via fallback, `ai_logs` shows `fallback_from` |
| 9 | Cutover: Supabase Pro, alerts, docs | 2 | dead-man's-switch alert fires on a simulated missed run |

~3–4 weeks solo at focused pace. Each phase ships evidence before the next starts — same protocol as the pipeline sessions.

## 18. FOLDER STRUCTURE

```
skyline/
├── frontend/                  # Vite + React
│   └── src/{api,components,views/{Deals,Buyers,Leaderboards,Agent,Uploads,Review},hooks,styles}
├── backend/                   # FastAPI
│   └── app/{main.py, routes/{deals,buyers,agent,uploads,review}.py,
│        services/{agent_tools.py, provider_router.py, providers/{groq,gemini,openrouter,cloudflare,anthropic,openai}.py,
│                  entity_resolution.py, upload_ingest.py},
│        db.py, auth.py}
├── worker/                    # the existing modules, unchanged logic
│   ├── traded_scraper.py  traded_backfill.py  acris_enrich.py
│   ├── phase2_stages.py  phase3_fresh.py  apply_enrichment.py  rolling_sales.py
│   └── store.py               # NEW: pickle→Postgres shim (ledgers, merges, gated writes)
├── shared/normalize.py        # norm_entity / canon_street / split_address — ONE implementation, imported by backend & worker
├── database/migrations/       # numbered SQL
├── scripts/{migrate_csv.py, assert_migration.py}
└── .github/workflows/{daily-incremental.yml, weekly-enrichment.yml, ci.yml}
```

## 19. ENVIRONMENT VARIABLES (complete list)

`DATABASE_URL` · `SUPABASE_URL` · `SUPABASE_ANON_KEY` (frontend-safe) · `SUPABASE_SERVICE_KEY` · `SUPABASE_JWT_SECRET` · `SOCRATA_APP_TOKEN` · `SCRAPERAPI_KEY` (fallback only) · `GEMINI_API_KEY` · `GROQ_API_KEY` · `OPENROUTER_API_KEY` · `CLOUDFLARE_ACCOUNT_ID` · `CLOUDFLARE_API_TOKEN` · `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `AI_PROVIDER_ORDER` · `AI_QUALITY_PROVIDER` · `FRONTEND_URL` · `ALERT_WEBHOOK_URL` · `VITE_API_URL` (frontend). Not included by design: any amount-gate tunable.

## 20. FINAL SYSTEM VISION

The end state is the artifact's exact experience — the four tabs, the deal-matching desk that parses a broker's ask and ranks buyers by their real track record — but alive: the dataset refreshes itself every morning off traded.co and ACRIS with the ledgers guaranteeing nothing excluded ever sneaks back in and nothing verified is ever overwritten; the 7–8-week ACRIS party lag closes itself every Sunday through the amount gate; brokers drop their own contact books and call logs in as CSVs and the entity resolver ties "Steve's cell" to the LLC that bought three Bronx multifamilies; and the agent answers "what's this owner's phone number," "who's the best buyer for this," and "when did we last talk to them" as SQL joins narrated by whichever of six providers is up, fast, and within quota — with every answer citing its rows, every fill citing its deed, and not one secret in the browser.

---

### Appendix: research citations (all checked 2026-07-02)
- Gemini rate limits & free-tier scope: ai.google.dev/gemini-api/docs/rate-limits (+ 2026 coverage: Pro removed from free tier Apr 2026; free tier = Flash/Flash-Lite; per-project limits; billing removes free tier on that project)
- Groq: console.groq.com/docs/rate-limits (org-level; 429 + headers; RPD not in headers) + published free limits ~30 RPM / 6K TPM / 1K–14.4K RPD by model
- OpenRouter: openrouter.ai/docs/api/reference/limits & /docs/faq — 50 req/day free, 1,000/day after $10 credits, 20 RPM on :free
- Cloudflare Workers AI: developers.cloudflare.com/workers-ai/platform/pricing — 10,000 neurons/day free, $0.011/1K beyond (paid plan), resets 00:00 UTC
- Anthropic: no ongoing free API tier; one-time ~$5 trial; Sonnet $3/$15 per MTok (pricing pages + 2026 guides)
- OpenAI: no permanent free tier; trial credits expire; opt-in data-sharing free-token program exists
- GitHub Actions: 2,000 free min/mo private repos (public unlimited); 5-min schedule floor; delays 5–30+ min common; 60-day inactivity disables schedules; 6-hour job cap (docs.github.com/actions/reference/limits + community discussions)
- ScraperAPI: free 1,000 credits/mo @ 5 concurrent; 5,000-credit 7-day trial; Hobby $49/100K; Cloudflare-protected sites +10 credits/request (scraperapi.com/pricing, docs.scraperapi.com)
- Supabase: free = 500 MB DB / 500K edge invocations / 5 GB egress / pgvector included / pauses after 7 idle days / no backups; Pro $25/mo (supabase.com/pricing + docs)
