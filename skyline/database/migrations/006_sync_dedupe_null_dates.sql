-- 006: sync_upsert_deals(), final form (applied to prod 2026-07-06 as
-- skyline_006_sync_dedupe_null_dates).
-- LESSON (self-annealing, 2026-07-06): the first sync run inserted 143 duplicate
-- deals because rows whose junk sale_date the client nulled slipped past the
-- address+price+date dedupe. Rule now: property+price match with dates equal OR
-- either date unknown counts as the same deal. Client also normalizes unpadded
-- dates (2026-6-8) instead of discarding them.

CREATE OR REPLACE FUNCTION sync_upsert_deals(rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r jsonb;
  role_rec record;
  v_prop uuid; v_deal uuid; v_ent uuid;
  n_inserted int := 0; n_dup int := 0; n_skipped_residential int := 0;
  n_skipped_invalid int := 0; n_parties int := 0; n_contacts int := 0; n_errors int := 0;
  err_samples text[] := '{}';
  v_addr text; v_norm text; v_boro text; v_atype text; v_price numeric; v_date date;
  v_src text; v_short text; v_status text; v_conf int;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    BEGIN
      v_short := nullif(trim(r->>'shortcode'), '');
      v_addr  := nullif(trim(r->>'address'), '');
      v_norm  := nullif(trim(r->>'address_norm'), '');
      v_boro  := nullif(trim(r->>'borough'), '');
      v_atype := nullif(trim(r->>'asset_type'), '');
      v_price := nullif(r->>'sale_price','')::numeric;
      v_date  := nullif(r->>'sale_date','')::date;
      v_src   := coalesce(nullif(r->>'source_system',''), 'other');
      v_status := CASE WHEN r->>'parse_status' = 'ok' THEN 'ok' ELSE 'needs_review' END;
      v_conf  := least(100, greatest(0, coalesce(round(nullif(r->>'confidence','')::numeric)::int, 50)));

      IF v_norm IS NULL OR v_addr IS NULL THEN
        n_skipped_invalid := n_skipped_invalid + 1; CONTINUE;
      END IF;
      IF v_boro IS NOT NULL AND v_boro NOT IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island') THEN
        v_boro := NULL;
      END IF;
      IF v_atype IN ('Condo','Commercial Condo','Co-op','Single Family') THEN
        n_skipped_residential := n_skipped_residential + 1; CONTINUE;
      END IF;

      IF v_short IS NOT NULL AND EXISTS (SELECT 1 FROM deals WHERE shortcode = v_short) THEN
        n_dup := n_dup + 1; CONTINUE;
      END IF;

      SELECT property_id INTO v_prop FROM properties
       WHERE address_norm = v_norm AND borough IS NOT DISTINCT FROM v_boro LIMIT 1;
      IF v_prop IS NULL THEN
        INSERT INTO properties (address_raw, address_norm, borough, market, bbl, units, sqft)
        VALUES (v_addr, v_norm, v_boro, nullif(r->>'market',''),
                nullif(r->>'bbl',''),
                round(nullif(r->>'units','')::numeric)::int,
                round(nullif(r->>'sqft','')::numeric)::int)
        RETURNING property_id INTO v_prop;
      ELSE
        UPDATE properties SET
          bbl   = coalesce(bbl, nullif(r->>'bbl','')),
          units = coalesce(units, round(nullif(r->>'units','')::numeric)::int),
          sqft  = coalesce(sqft, round(nullif(r->>'sqft','')::numeric)::int),
          updated_at = now()
        WHERE property_id = v_prop;
      END IF;

      IF EXISTS (SELECT 1 FROM deals WHERE property_id = v_prop
                   AND sale_price IS NOT DISTINCT FROM v_price
                   AND (sale_date IS NOT DISTINCT FROM v_date
                        OR v_date IS NULL OR sale_date IS NULL)) THEN
        n_dup := n_dup + 1; CONTINUE;
      END IF;

      INSERT INTO deals (property_id, sale_date, post_date, asset_type, sale_price, units, sqft,
                         source_system, source_url, shortcode, confidence, parse_status, notes)
      VALUES (v_prop, v_date, nullif(r->>'post_date','')::date, v_atype, v_price,
              round(nullif(r->>'units','')::numeric)::int,
              round(nullif(r->>'sqft','')::numeric)::int,
              CASE WHEN v_src IN ('acris','traded','crexi','instagram','upload') THEN v_src ELSE 'other' END,
              nullif(r->>'source_url',''), v_short, v_conf, v_status,
              nullif(r->>'notes',''))
      RETURNING deal_id INTO v_deal;
      n_inserted := n_inserted + 1;

      FOR role_rec IN SELECT * FROM (VALUES
        ('buyer',  r->>'buyer',  r->>'buyer_norm',  r->>'buyer_address',  r->>'buyer_phone',  r->>'buyer_email'),
        ('seller', r->>'seller', r->>'seller_norm', r->>'seller_address', r->>'seller_phone', r->>'seller_email')
      ) AS t(prole, disp, norm, mail, phone, email) LOOP
        IF nullif(trim(coalesce(role_rec.disp,'')),'') IS NULL
           OR nullif(trim(coalesce(role_rec.norm,'')),'') IS NULL THEN CONTINUE; END IF;
        SELECT entity_id INTO v_ent FROM entities WHERE norm_name = trim(role_rec.norm);
        IF v_ent IS NULL THEN
          INSERT INTO entities (display_name, norm_name, mailing_address)
          VALUES (trim(role_rec.disp), trim(role_rec.norm), nullif(role_rec.mail,''))
          ON CONFLICT (norm_name) DO UPDATE SET display_name = entities.display_name
          RETURNING entity_id INTO v_ent;
        END IF;
        INSERT INTO deal_parties (deal_id, entity_id, role, mailing_address, source_system,
                                  provenance_ref, amount_gate_passed, verified_deed_amount, match_confidence)
        VALUES (v_deal, v_ent, role_rec.prole, nullif(role_rec.mail,''),
                CASE WHEN v_src IN ('acris','traded','crexi') THEN v_src ELSE 'base44' END,
                coalesce(nullif(r->>'source_url',''), 'base44:sync'),
                CASE WHEN v_src = 'acris' THEN true ELSE NULL END,
                CASE WHEN v_src = 'acris' THEN v_price ELSE NULL END,
                v_conf)
        ON CONFLICT (deal_id, entity_id, role) DO NOTHING;
        n_parties := n_parties + 1;

        IF nullif(role_rec.phone,'') IS NOT NULL OR nullif(role_rec.email,'') IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM contacts WHERE entity_id = v_ent
                           AND phone IS NOT DISTINCT FROM nullif(role_rec.phone,'')
                           AND email IS NOT DISTINCT FROM nullif(role_rec.email,'')) THEN
            INSERT INTO contacts (entity_id, phone, email, mailing_address, source, confidence)
            VALUES (v_ent, nullif(role_rec.phone,''), nullif(role_rec.email,''),
                    nullif(role_rec.mail,''), 'base44:sync', 80);
            n_contacts := n_contacts + 1;
          END IF;
        END IF;
      END LOOP;

    EXCEPTION WHEN OTHERS THEN
      n_errors := n_errors + 1;
      IF coalesce(array_length(err_samples,1),0) < 5 THEN
        err_samples := err_samples || (coalesce(v_short, v_norm, '?') || ': ' || SQLERRM);
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted', n_inserted, 'dup', n_dup,
    'skipped_residential', n_skipped_residential, 'skipped_invalid', n_skipped_invalid,
    'parties', n_parties, 'contacts', n_contacts,
    'errors', n_errors, 'error_samples', to_jsonb(err_samples));
END $$;

REVOKE ALL ON FUNCTION sync_upsert_deals(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_upsert_deals(jsonb) TO service_role;

-- Nightly trigger (job 'skyline-sync-daily', 07:40 UTC — after the dealflow train):
--   SELECT cron.schedule('skyline-sync-daily', '40 7 * * *', $cmd$
--     select net.http_post(
--       url:='https://<project>.supabase.co/functions/v1/skyline-sync',
--       headers:='{"Content-Type":"application/json"}'::jsonb,
--       body:=jsonb_build_object('secret', (select value from app_config where key='sync_secret')));
--   $cmd$);
