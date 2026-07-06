# Decisions Log

Each entry: what was decided, and why. If a decision is reversed, append — never delete.

## 2026-07-06

**D-001 — Layer B.L.A.S.T. structure alongside the existing `skyline/` app, not inside it.**
`/memory/`, `/architecture/`, `/execution/`, `CLAUDE.md` live at repo root; `skyline/` is
treated as prior art / an existing engine, untouched until the Blueprint says otherwise.
*Why:* Surgical Changes principle — the existing system is tested and documented; restructuring
it before knowing the North Star would be speculative.

**D-002 — Treat `SKYLINE_MASTER_BLUEPRINT.md` as inherited research, not as the approved Blueprint.**
Its schemas and constraints are logged in findings.md and referenced by CLAUDE.md, but Phase B
discovery still runs: the user's North Star for *buyerDB* may extend or diverge from it.
*Why:* Never guess at business logic; the blueprint predates this protocol and this task.

**D-003 — `/.tmp/` is gitignored; `/memory/`, `/architecture/`, `CLAUDE.md` are committed.**
*Why:* memory must survive container recycling (remote ephemeral environment); intermediates must not
pollute the repo.

**D-004 — Existing repo invariants adopted as provisional Behavioral Rules in CLAUDE.md.**
Amount gate, no-residential, never-overwrite-non-null, flagged-not-resolved conflicts,
no fabricated contacts, no contact data to trainable free tiers.
*Why:* each one encodes a documented, hard-won failure (e.g. the 34/34 wrong-party audit);
dropping them silently would re-introduce known error classes. User may amend in Phase B.
