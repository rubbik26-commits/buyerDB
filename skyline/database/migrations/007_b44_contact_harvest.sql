-- 007: one-time harvest of enriched Base44 Contact records into Skyline
-- (applied to prod 2026-07-06 as skyline_007_b44_contact_harvest).
-- Result: 6,344 staged -> 4,498 entities matched, 1,521 contacts inserted,
-- 4,457 entity mailing addresses filled. Staging table cleared after run.
-- Source below exported verbatim from the production migration history
-- (supabase_migrations.schema_migrations, 2026-07-07) so the repo can rebuild
-- a matching schema; previously this file was a stub.
--
-- 007: one-time harvest of enriched Base44 Contact records (phones/emails/key
-- persons/mailing addresses from dos-enrich + llm-enrich work) into Skyline
-- contacts/entities before Base44 is retired. Invariants: never overwrite
-- non-null, contacts carry source provenance, no fabricated values.

CREATE TABLE IF NOT EXISTS b44_contact_staging (
  name text, role text, phone text, email text,
  key_person text, mailing text, company text, source_tag text
);
ALTER TABLE b44_contact_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY b44_staging_service_all ON b44_contact_staging
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION harvest_b44_contacts()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n_staged int; n_matched int; n_contacts int; n_mailing int;
BEGIN
  SELECT count(*) INTO n_staged FROM b44_contact_staging;

  CREATE TEMP TABLE _matched ON COMMIT DROP AS
  SELECT DISTINCT ON (e.entity_id, s.phone, s.email)
         e.entity_id, s.name, s.role, nullif(trim(s.phone),'') AS phone,
         nullif(trim(s.email),'') AS email, nullif(trim(s.key_person),'') AS key_person,
         nullif(trim(s.mailing),'') AS mailing, nullif(trim(s.company),'') AS company,
         coalesce(nullif(s.source_tag,''),'contact') AS source_tag
  FROM b44_contact_staging s
  JOIN entities e ON e.norm_name = upper(trim(s.name));

  SELECT count(DISTINCT entity_id) INTO n_matched FROM _matched;

  WITH ins AS (
    INSERT INTO contacts (entity_id, person_name, phone, email, mailing_address, source, confidence)
    SELECT m.entity_id, m.key_person, m.phone, m.email, m.mailing,
           'base44:' || m.source_tag, 70
    FROM _matched m
    WHERE (m.phone IS NOT NULL OR m.email IS NOT NULL OR m.key_person IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id = m.entity_id
                        AND c.phone IS NOT DISTINCT FROM m.phone
                        AND c.email IS NOT DISTINCT FROM m.email
                        AND c.person_name IS NOT DISTINCT FROM m.key_person)
    RETURNING 1)
  SELECT count(*) INTO n_contacts FROM ins;

  WITH upd AS (
    UPDATE entities e SET mailing_address = m.mailing
    FROM (SELECT DISTINCT ON (entity_id) entity_id, mailing FROM _matched
          WHERE mailing IS NOT NULL) m
    WHERE e.entity_id = m.entity_id AND e.mailing_address IS NULL
    RETURNING 1)
  SELECT count(*) INTO n_mailing FROM upd;

  RETURN jsonb_build_object('staged', n_staged, 'entities_matched', n_matched,
    'contacts_inserted', n_contacts, 'mailing_filled', n_mailing);
END $$;

REVOKE ALL ON FUNCTION harvest_b44_contacts() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION harvest_b44_contacts() TO service_role;
