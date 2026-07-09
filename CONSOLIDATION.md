# Buyer Repository Consolidation

Date: 2026-07-09
Target repository: `rubbik26-commits/buyerDB`
Production Netlify project: `buyerdb`
Production URL: `https://buyerdb.netlify.app`
Production branch: `ACRIS`

## Decision

`rubbik26-commits/buyerDB` is the single repository of record for the Skyline Buyer Intelligence / Deal Intelligence system.

`rubbik26-commits/buyers` is now treated as the upstream legacy/source repository that supplied the original core app, worker, backend, migrations, and tests. Its canonical functionality has been consolidated into `buyerDB` under the nested `skyline/` application directory.

## What was combined

The original `buyers` repo contained the core Skyline Deal Intelligence system:

- React/Vite frontend tabs for Deals, Buyers, Leaderboards, Deal Desk, Contacts/Uploads, and Review.
- FastAPI backend routes for deals, agent, uploads, and review.
- Python worker modules for Traded, ACRIS, phase-two/phase-three enrichment, rolling sales, incremental runs, and gated merge logic.
- Postgres schema migration and migration/assertion scripts.
- Tests for worker behavior, provider fallback, migration correctness, and agent behavior.

The target `buyerDB` repo keeps that core functionality and extends it:

- App code lives under `skyline/` instead of the repo root.
- Netlify builds from `skyline/frontend` using the root `netlify.toml`.
- Frontend is expanded beyond the original tabs to include Workbench, Properties, Map, Outreach, Tasks, Scrapers, and Audit.
- Live data mode supports Supabase PostgREST/RPC functions for the static Netlify deployment.
- Netlify Functions provide the non-RPC API surface: `agent`, `core-routes`, `seed-canonical`, and `workflow`.
- Supabase edge functions and SQL migrations support the live refresh path.
- FastAPI remains available as the optional full backend for uploads, merges, and AI Deal Desk workflows.
- GitHub Actions worker jobs remain as a legacy/fallback path.

## Current Netlify status verified during consolidation

The Netlify project named `buyerdb` is live and healthy.

Current production deploy metadata shows:

- Site ID: `e1780534-ba0b-470e-b98f-85b29f7d32a1`
- Project name: `buyerdb`
- Primary URL: `https://buyerdb.netlify.app`
- Branch deploy URL: `https://acris--buyerdb.netlify.app`
- Current deploy ID: `6a4ff5a984824e0008db3fae`
- Deploy state: `ready`
- Branch: `ACRIS`
- Commit URL: `https://github.com/rubbik26-commits/buyerDB/commit/9114c068dbc59031e4bd32e620ad0ab0d3f77867`
- Framework: `vite`
- Functions deployed: `agent`, `core-routes`, `seed-canonical`, `workflow`

That confirms Netlify is now deploying from the consolidated `buyerDB` repository, not the old `buyers` repository.

## Netlify build contract

Netlify must remain linked to:

- Repository: `rubbik26-commits/buyerDB`
- Branch: `ACRIS`
- Build base: `skyline/frontend`
- Build command: `npm install && npm run build`
- Publish directory: `dist`

Root `netlify.toml` contains the deploy contract:

```toml
[build]
  base = "skyline/frontend"
  command = "npm install && npm run build"
  publish = "dist"

[functions]
  directory = "netlify/functions"
```

## Merge decisions made in this pass

The active `buyerDB` implementation is newer than the legacy `buyers` repo in several production-critical areas: it has the nested `skyline/` layout, Supabase RPC/static Netlify support, CSV fallback for Netlify API routes, Map support, seed-canonical function, Supabase edge functions, and later migrations.

Therefore the merge direction is:

1. Keep `buyerDB` as the canonical deployable app.
2. Do not overwrite newer `buyerDB` files with older `buyers` files.
3. Pull forward useful legacy improvements from `buyers` where they are missing in `buyerDB`.
4. Preserve Netlify production compatibility.

Implemented merge items:

- Frontend shell resilience from `buyers`: the app now keeps the dashboard shell open and uses empty metadata if `/api/meta` fails instead of leaving the active view unloaded.
- Frontend navigation polish from `buyers`: tab buttons now include titles and consistent display behavior, while preserving the newer `buyerDB` Map tab.
- API client compatibility from `buyers`: added `savedViews`, `saveView`, and `deleteView` helpers to the non-RPC API client path.
- CSV upload mapping from `buyers`: expanded column aliases for contacts, deals, buyer/seller fields, dates, borough, market, sale price, units, square footage, source URL, and shortcode.
- Netlify-local request safety from `buyers`: POST and DELETE helpers now resolve through the same `apiUrl()` path logic used by GET requests.

## Repository operating rule going forward

All future code changes, Netlify deploys, Supabase edge-function sources, migrations, documentation, and production fixes should happen in:

`rubbik26-commits/buyerDB`

The old `buyers` repository should not receive new product work unless it is intentionally being preserved as a read-only archive or fallback reference.

## Verification checklist

Before considering the consolidation complete:

1. Netlify project `buyerdb` remains linked to `rubbik26-commits/buyerDB`.
2. Production branch is `ACRIS`.
3. Netlify build base is `skyline/frontend`.
4. Netlify build command is `npm install && npm run build`.
5. Publish directory is `dist`.
6. Production deploy URL is `https://buyerdb.netlify.app`.
7. Deploy metadata commit URL points to `rubbik26-commits/buyerDB`.
8. The site loads the expanded `buyerDB` application shell with Workbench, Properties, Map, Outreach, Tasks, Scrapers, Audit, Deals, Buyers, Leaderboards, Deal Desk, Contacts, and Review.
9. `/api/health`, `/api/meta`, `/api/deals`, `/api/buyers`, `/api/leaderboards`, `/api/agent`, and workflow routes continue responding after merge.
