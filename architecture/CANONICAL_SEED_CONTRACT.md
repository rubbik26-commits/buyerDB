# Canonical Seed Integrity Contract

The canonical CSV loader is a maintenance path, not a public application API.

## Data rules

- Reject any parser fragment that has no shortcode, source URL, sale date, sale price, buyer, seller, or asset type.
- Preserve a deterministic audit hash before removing a provably malformed seed row.
- Do not delete a sourced row merely because one field is missing; the guard applies only when every transaction identifier and fact is absent.
- Keep the commercial/residential exclusion gate, amount gate, source provenance, and deal deduplication rules unchanged.

## Access rules

- `api_seed_canonical_csv_rows` is executable only by `service_role`.
- The unfiltered implementation remains private and is never exposed to browser roles.
- `api_seed_from_github_csv` is executable only by `service_role`.
- The Netlify seed function accepts POST only, requires a server-side admin credential, and requires a Supabase service-role key. It never falls back to the publishable key.

## Production evidence

The live audit must report:

- zero factless canonical-seed deal rows;
- zero browser-role grants on seed maintenance RPCs;
- two malformed historical seed fragments preserved in the exclusion ledger by audit hash;
- the canonical NYC deal count reconciled to the current CSV after non-NYC rows are excluded.
