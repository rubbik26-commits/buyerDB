-- 008: write paths for broker contacts (crexi-ingest) and NYS DOS enrichment
-- (dos-enrich) for the Base44-free pipeline (applied to prod 2026-07-06 as
-- skyline_008_broker_and_dos_writes).
-- upsert_broker_contacts(rows jsonb) -> entities + contacts (source 'crexi:broker')
-- dos_targets(lim) -> company-like buyer/seller entities lacking a nys_dos contact
-- dos_apply(rows jsonb) -> mailing fill (null-only) + one 'nys_dos' contact/entity
-- All three: SECURITY DEFINER, EXECUTE granted to service_role only.
-- Source below exported verbatim from production (pg_get_functiondef,
-- 2026-07-07) so the repo can rebuild a matching schema; previously a stub.

CREATE OR REPLACE FUNCTION public.upsert_broker_contacts(rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r jsonb; v_ent uuid; n_entities int := 0; n_contacts int := 0; n_skipped int := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    IF nullif(trim(r->>'name'),'') IS NULL THEN n_skipped := n_skipped + 1; CONTINUE; END IF;
    SELECT entity_id INTO v_ent FROM entities WHERE norm_name = upper(trim(r->>'name'));
    IF v_ent IS NULL THEN
      INSERT INTO entities (display_name, norm_name, entity_type)
      VALUES (trim(r->>'name'), upper(trim(r->>'name')), 'individual')
      ON CONFLICT (norm_name) DO UPDATE SET display_name = entities.display_name
      RETURNING entity_id INTO v_ent;
      n_entities := n_entities + 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM contacts WHERE entity_id = v_ent
                     AND phone IS NOT DISTINCT FROM nullif(r->>'phone','')
                     AND person_name IS NOT DISTINCT FROM nullif(trim(r->>'name'),'')) THEN
      INSERT INTO contacts (entity_id, person_name, title, phone, source, confidence)
      VALUES (v_ent, nullif(trim(r->>'name'),''), nullif(r->>'company',''),
              nullif(r->>'phone',''), 'crexi:broker', 70);
      n_contacts := n_contacts + 1;
    ELSE
      n_skipped := n_skipped + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('entities_created', n_entities, 'contacts_inserted', n_contacts, 'skipped', n_skipped);
END $function$;

CREATE OR REPLACE FUNCTION public.dos_targets(lim integer DEFAULT 400)
 RETURNS TABLE(entity_id uuid, norm_name text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT e.entity_id, e.norm_name
  FROM entities e
  WHERE EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.entity_id = e.entity_id
                  AND dp.role IN ('buyer','seller'))
    AND e.norm_name ~ '\m(LLC|INC|CORP|CORPORATION|LP|LTD|COMPANY|HOLDINGS|REALTY|PROPERTIES|GROUP|ASSOCIATES|PARTNERS|TRUST|MANAGEMENT|CAPITAL|VENTURES|ENTERPRISES|FUND)\M'
    AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id = e.entity_id AND c.source = 'nys_dos')
  ORDER BY (SELECT count(*) FROM deal_parties dp2 WHERE dp2.entity_id = e.entity_id) DESC
  LIMIT lim;
$function$;

CREATE OR REPLACE FUNCTION public.dos_apply(rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r jsonb; n_mailing int := 0; n_contacts int := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    UPDATE entities SET mailing_address = nullif(r->>'mailing','')
     WHERE entity_id = (r->>'entity_id')::uuid AND mailing_address IS NULL
       AND nullif(r->>'mailing','') IS NOT NULL;
    IF FOUND THEN n_mailing := n_mailing + 1; END IF;
    IF NOT EXISTS (SELECT 1 FROM contacts WHERE entity_id = (r->>'entity_id')::uuid AND source = 'nys_dos') THEN
      INSERT INTO contacts (entity_id, person_name, mailing_address, source, confidence)
      VALUES ((r->>'entity_id')::uuid, nullif(r->>'key_person',''),
              nullif(r->>'mailing',''), 'nys_dos', 85);
      n_contacts := n_contacts + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('mailing_filled', n_mailing, 'contacts_inserted', n_contacts);
END $function$;

REVOKE ALL ON FUNCTION upsert_broker_contacts(jsonb), dos_targets(integer), dos_apply(jsonb)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_broker_contacts(jsonb), dos_targets(integer), dos_apply(jsonb)
  TO service_role;
