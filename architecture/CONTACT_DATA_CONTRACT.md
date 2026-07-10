# Canonical Contact Data Contract

The live SBI contact layer is populated only from sourced rows or broker uploads. It never fabricates a phone number, email address, website, contact name, or mailing address.

## Canonical CSV import

`025_canonical_contact_import.sql` imports Buyer/Seller Phone, Email, Website, and Address fields from `NEW_YORK_CLOSED_ENRICHED_v8.csv` into `sbi_contacts`.

Rules:

- Link contacts through the canonical normalized entity key.
- Preserve `canonical_csv_v8` as the source and retain shortcode/source URL provenance.
- Never overwrite an existing non-null contact value.
- Keep mailing-only public-record contacts; absence of phone/email is represented honestly.
- Reject placeholder entity names.
- Normalize phone, email, website, and mailing-address formats before deduplication.
- Assign no more than one primary contact per entity.
- Restrict import, dedupe, and primary-ranking RPCs to `service_role`.

## Production verification

`execution/verify_live_sbi.sh` fails when it finds orphan contacts, multiple primary contacts, normalized duplicate contacts, placeholder entities, public maintenance-RPC grants, or any existing deal-ledger invariant failure.

The entity drawer renders every available sourced field: person/company, role, phone, email, website, mailing address, source, confidence, and primary status.
