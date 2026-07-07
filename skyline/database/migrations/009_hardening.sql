-- 009: hardening pass (2026-07-07) — NOT YET APPLIED TO PROD.
-- Fixes found in the 2026-07-07 full-system review:
--   A) api_buyers: the LEFT JOIN contacts multiplied every deal-party row by the
--      entity's contact count — a buyer with 2 deals and 3 contacts showed n=6
--      and 3x volume. Post-007/008 harvesting (1,500+ contacts) made this
--      widespread. has_contact is now an EXISTS probe.
--   B) api_review_act was an unauthenticated write: anyone with the public anon
--      key could resolve/dismiss any review item (the place invariant #3
--      conflicts are adjudicated). Revoked from anon; the RPC-mode frontend
--      degrades honestly (review actions need the backend).
--   C) sync_upsert_deals v3:
--      - advisory lock: two overlapping invocations could re-create the
--        143-duplicate incident (check-then-insert with NULL-tolerant dedupe);
--      - residential skip list aligned with 001's no_residential CHECK
--        ('Two Family', '1-2 Family' used to reach the INSERT and be
--        miscounted as errors);
--      - statewide boroughs preserved (006 nulled anything non-NYC, undoing
--        migration 002 and forking Nassau/Suffolk properties from their CSV
--        originals); NYC borough spellings are canonicalized instead;
--      - amount gate takes explicit deed evidence (deed_amount) and verifies
--        the 3% rule in SQL; an ACRIS row with a price but no explicit deed
--        amount keeps gate=true with verified_deed_amount=price because in the
--        sync path the price IS document_amt (deed == price by construction);
--        an ACRIS row with NO price gets no party attach and a review_queue
--        entry instead of a guaranteed CHECK violation;
--      - property-field conflicts (bbl/units/sqft disagreeing with stored
--        non-null values) are flagged to review_queue per invariant #3 instead
--        of silently dropped;
--      - the parties counter uses ROW_COUNT (ON CONFLICT DO NOTHING used to be
--        counted as an insert).
--   D) indexes: review_queue(status) for api_review/api_meta; trigram indexes
--      on the two columns api_deals actually ILIKE-searches.

-- ---------------------------------------------------------------------------
-- A) api_buyers — contacts fan-out fix
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_buyers(
  borough text DEFAULT NULL, asset_type text DEFAULT NULL,
  price_min numeric DEFAULT NULL, price_max numeric DEFAULT NULL,
  date_min date DEFAULT NULL, min_deals int DEFAULT 1,
  rank_by text DEFAULT 'count', lim int DEFAULT 60)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH g AS (
    SELECT e.entity_id, e.display_name AS name, e.is_spv_suspect,
           count(*) AS n, coalesce(sum(d.sale_price), 0) AS vol,
           max(d.sale_date) AS last_deal,
           min(d.sale_price) AS min_price, max(d.sale_price) AS max_price,
           array_agg(DISTINCT d.asset_type) FILTER (WHERE d.asset_type IS NOT NULL) AS types,
           array_agg(DISTINCT p.borough) FILTER (WHERE p.borough IS NOT NULL) AS boroughs,
           EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id = e.entity_id) AS has_contact
    FROM deal_parties dp
    JOIN entities e USING (entity_id)
    JOIN deals d USING (deal_id)
    JOIN properties p USING (property_id)
    WHERE dp.role = 'buyer'
      AND (api_buyers.borough IS NULL OR api_buyers.borough = '' OR p.borough = api_buyers.borough)
      AND (api_buyers.asset_type IS NULL OR api_buyers.asset_type = '' OR d.asset_type = api_buyers.asset_type)
      AND (api_buyers.price_min IS NULL OR d.sale_price >= api_buyers.price_min)
      AND (api_buyers.price_max IS NULL OR d.sale_price <= api_buyers.price_max)
      AND (api_buyers.date_min IS NULL OR d.sale_date >= api_buyers.date_min)
    GROUP BY e.entity_id, e.display_name, e.is_spv_suspect
    HAVING count(*) >= greatest(api_buyers.min_deals, 1)
    ORDER BY CASE WHEN api_buyers.rank_by = 'vol' THEN coalesce(sum(d.sale_price), 0) ELSE count(*) END DESC
    LIMIT least(greatest(api_buyers.lim, 1), 200)
  )
  SELECT jsonb_build_object('buyers', coalesce(
    (SELECT jsonb_agg(to_jsonb(g)) FROM g), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- B) api_review_act — no anonymous writes
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION api_review_act(uuid, text, text) FROM anon;

-- ---------------------------------------------------------------------------
-- C) sync_upsert_deals v3
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_upsert_deals(rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r jsonb;
  role_rec record;
  v_prop uuid; v_deal uuid; v_ent uuid;
  n_inserted int := 0; n_dup int := 0; n_skipped_residential int := 0;
  n_skipped_invalid int := 0; n_parties int := 0; n_contacts int := 0; n_errors int := 0;
  n_conflicts int := 0; n_gate_blocked int := 0;
  err_samples text[] := '{}';
  v_addr text; v_norm text; v_boro text; v_atype text; v_price numeric; v_date date;
  v_src text; v_short text; v_status text; v_conf int;
  v_deed numeric; v_gate boolean; v_deed_amt numeric;
  v_old_bbl text; v_old_units int; v_old_sqft int;
  v_new_bbl text; v_new_units int; v_new_sqft int;
  v_rc int;
BEGIN
  -- One writer at a time: the dedupe below is check-then-insert and its unique
  -- indexes don't bind when sale_price/sale_date/borough are NULL, so two
  -- overlapping invocations (cron + manual run) could double-insert.
  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_deals'));

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
      v_deed  := nullif(r->>'deed_amount','')::numeric;

      IF v_norm IS NULL OR v_addr IS NULL THEN
        n_skipped_invalid := n_skipped_invalid + 1; CONTINUE;
      END IF;
      -- Canonicalize NYC borough spellings; keep statewide values (002 dropped
      -- the five-borough CHECK on purpose — nulling Nassau/Suffolk forked
      -- their properties from the CSV-loaded originals).
      v_boro := CASE lower(v_boro)
        WHEN 'manhattan' THEN 'Manhattan' WHEN 'brooklyn' THEN 'Brooklyn'
        WHEN 'queens' THEN 'Queens' WHEN 'bronx' THEN 'Bronx'
        WHEN 'staten island' THEN 'Staten Island' ELSE v_boro END;
      -- Same list as 001's no_residential CHECK — anything narrower reaches the
      -- INSERT and gets miscounted as an error.
      IF v_atype IN ('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family') THEN
        n_skipped_residential := n_skipped_residential + 1; CONTINUE;
      END IF;

      IF v_short IS NOT NULL AND EXISTS (SELECT 1 FROM deals WHERE shortcode = v_short) THEN
        n_dup := n_dup + 1; CONTINUE;
      END IF;

      SELECT property_id, bbl, units, sqft INTO v_prop, v_old_bbl, v_old_units, v_old_sqft
        FROM properties
       WHERE address_norm = v_norm AND borough IS NOT DISTINCT FROM v_boro LIMIT 1;
      v_new_bbl   := nullif(r->>'bbl','');
      v_new_units := round(nullif(r->>'units','')::numeric)::int;
      v_new_sqft  := round(nullif(r->>'sqft','')::numeric)::int;
      IF v_prop IS NULL THEN
        INSERT INTO properties (address_raw, address_norm, borough, market, bbl, units, sqft)
        VALUES (v_addr, v_norm, v_boro, nullif(r->>'market',''), v_new_bbl, v_new_units, v_new_sqft)
        RETURNING property_id INTO v_prop;
      ELSE
        -- Never overwrite non-null; a DISAGREEING non-null incoming value is a
        -- conflict and must be flagged, not dropped (invariant #3).
        IF (v_old_bbl IS NOT NULL AND v_new_bbl IS NOT NULL AND v_old_bbl <> v_new_bbl)
           OR (v_old_units IS NOT NULL AND v_new_units IS NOT NULL AND v_old_units <> v_new_units)
           OR (v_old_sqft IS NOT NULL AND v_new_sqft IS NOT NULL AND v_old_sqft <> v_new_sqft) THEN
          INSERT INTO review_queue (object_type, object_id, issue_class, severity, payload)
          VALUES ('property', v_prop, 'field_conflict', 'warn',
                  jsonb_build_object('source', v_src, 'shortcode', v_short,
                    'stored', jsonb_build_object('bbl', v_old_bbl, 'units', v_old_units, 'sqft', v_old_sqft),
                    'incoming', jsonb_build_object('bbl', v_new_bbl, 'units', v_new_units, 'sqft', v_new_sqft)));
          n_conflicts := n_conflicts + 1;
        END IF;
        UPDATE properties SET
          bbl   = coalesce(bbl, v_new_bbl),
          units = coalesce(units, v_new_units),
          sqft  = coalesce(sqft, v_new_sqft),
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

      -- Amount gate (invariant #1), computed HERE, not asserted by the caller:
      --   explicit deed evidence -> verify the 3% rule;
      --   acris row with a price and no explicit deed -> price IS document_amt
      --   in the sync path (deal and deed come from the same ACRIS record);
      --   acris row with no price and no deed -> no evidence, parties blocked.
      IF v_src = 'acris' THEN
        IF v_deed IS NOT NULL AND v_price IS NOT NULL THEN
          v_gate := abs(v_deed - v_price) <= 0.03 * v_price;
          v_deed_amt := v_deed;
        ELSIF v_price IS NOT NULL THEN
          v_gate := true; v_deed_amt := v_price;
        ELSE
          v_gate := NULL; v_deed_amt := NULL;
        END IF;
      ELSE
        v_gate := NULL; v_deed_amt := NULL;
      END IF;

      FOR role_rec IN SELECT * FROM (VALUES
        ('buyer',  r->>'buyer',  r->>'buyer_norm',  r->>'buyer_address',  r->>'buyer_phone',  r->>'buyer_email'),
        ('seller', r->>'seller', r->>'seller_norm', r->>'seller_address', r->>'seller_phone', r->>'seller_email')
      ) AS t(prole, disp, norm, mail, phone, email) LOOP
        IF nullif(trim(coalesce(role_rec.disp,'')),'') IS NULL
           OR nullif(trim(coalesce(role_rec.norm,'')),'') IS NULL THEN CONTINUE; END IF;

        IF v_src = 'acris' AND v_gate IS DISTINCT FROM true THEN
          -- No gate evidence (or 3% rule failed): the acris_requires_gate CHECK
          -- would reject the row anyway — flag it for review instead of burning
          -- an error.
          INSERT INTO review_queue (object_type, object_id, issue_class, severity, payload)
          VALUES ('deal', v_deal, 'acris_gate_blocked', 'warn',
                  jsonb_build_object('role', role_rec.prole, 'name', role_rec.disp,
                    'deed_amount', v_deed, 'sale_price', v_price, 'shortcode', v_short));
          n_gate_blocked := n_gate_blocked + 1;
          CONTINUE;
        END IF;

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
                CASE WHEN v_src = 'acris' THEN v_gate ELSE NULL END,
                CASE WHEN v_src = 'acris' THEN v_deed_amt ELSE NULL END,
                v_conf)
        ON CONFLICT (deal_id, entity_id, role) DO NOTHING;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        n_parties := n_parties + v_rc;

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
    'conflicts_flagged', n_conflicts, 'gate_blocked', n_gate_blocked,
    'errors', n_errors, 'error_samples', to_jsonb(err_samples));
END $$;

REVOKE ALL ON FUNCTION sync_upsert_deals(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_upsert_deals(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- D) indexes the RPC layer actually needs
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue (status);
CREATE INDEX IF NOT EXISTS idx_properties_address_trgm
  ON properties USING gin (address_raw gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_display_trgm
  ON entities USING gin (display_name gin_trgm_ops);

NOTIFY pgrst, 'reload schema';
