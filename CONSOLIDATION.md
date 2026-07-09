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
- Supabase edge functions and SQL migrations support the live refresh path.
- FastAPI remains available as the optional full backend for uploads, merges, and AI Deal Desk workflows.
- GitHub Actions worker jobs remain as a legacy/fallback path.

## Current Netlify issue found during consolidation

The Netlify project named `buyerdb` is live and healthy, but its current deploy metadata shows that production is still deploying from:

- Repository: `rubbik26-commits/buyers`
- Branch: `ACRIS`
- Commit: `1d3c6fe2c1ae8398a87cdabc2959ee4ee5f6e7a1`
- Deploy ID: `6a4f8f0026471d8cd84bd500`

That means Netlify is not yet using the consolidated source-of-truth repo, even though `buyerDB` already has the deploy-ready `netlify.toml`.

## Required Netlify correction

In Netlify project `buyerdb`, the linked Git repository must be changed from:

`rubbik26-commits/buyers`

To:

`rubbik26-commits/buyerDB`

Use branch:

`ACRIS`

Build settings must remain:

```toml
[build]
  base = "skyline/frontend"
  command = "npm install && npm run build"
  publish = "dist"
```

After relinking, trigger a production deploy and verify the deploy commit URL points to `rubbik26-commits/buyerDB`, not `rubbik26-commits/buyers`.

## Repository operating rule going forward

All future code changes, Netlify deploys, Supabase edge-function sources, migrations, documentation, and production fixes should happen in:

`rubbik26-commits/buyerDB`

The old `buyers` repository should not receive new product work unless it is intentionally being preserved as a read-only archive or fallback reference.

## Verification checklist

Before considering the consolidation complete:

1. Netlify project `buyerdb` is relinked to `rubbik26-commits/buyerDB`.
2. Production branch is `ACRIS`.
3. Netlify build base is `skyline/frontend`.
4. Netlify build command is `npm install && npm run build`.
5. Publish directory is `dist`.
6. Production deploy URL is `https://buyerdb.netlify.app`.
7. Deploy metadata commit URL points to `rubbik26-commits/buyerDB`.
8. The site loads the expanded `buyerDB` application shell with Workbench, Properties, Map, Outreach, Tasks, Scrapers, Audit, Deals, Buyers, Leaderboards, Deal Desk, Contacts, and Review.
