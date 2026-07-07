# /execution/ — Layer T (Tools)

Deterministic, atomic, testable scripts. Credentials from `.env` only; intermediates via `/.tmp/`.

Contents:

- `probe_links.sh` — Phase L connectivity probe: hits the credential-free links
  (Supabase PostgREST RPC health, Netlify site, Socrata/ACRIS) and reports
  green/red per link. Safe to run any time; needs no secrets.

The heavier deterministic logic lives with the existing engine on purpose:
`skyline/worker/` (scraper/enrichment pipeline), `skyline/shared/normalize.py`
(the single implementation of the normalization invariants), and
`skyline/database/migrations/` (the SQL write path).
