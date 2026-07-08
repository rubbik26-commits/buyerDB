-- 010_workflow_rpc_api.sql
-- Supabase-native workflow implementation for the static Netlify app.
-- This removes the RPC-mode "backend required" gap for Workbench, Properties,
-- Tasks, interaction logging, scraper requests, and CSV contact uploads.

BEGIN;

CREATE OR REPLACE FUNCTION api_workbench()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH buyer_rollup AS (
    SELECT e.entity_id, e.display_name AS name, count(*) AS deal_count,
           coalesce(sum(d.sale_price), 0) AS volume, max(d.sale_date) AS last_deal,
           count(c.contact_id) AS contact_count
    FROM deal_parties dp
    JOIN entities e USING (entity_id)
    JOIN deals d USING (deal_id)
    LEFT JOIN contacts c ON c.entity_id = e.entity_id
    WHERE dp.role = 'buyer'
    GROUP BY e.entity_id, e.display_name
  ), latest_deal AS (
    SELECT DISTINCT ON (d.property_id)
           d.property_id, d.deal_id, d.sale_date, d.sale_price, d.asset_type,
           p.address_raw AS address, p.borough, p.market, p.bbl,
           b.entity_id AS owner_entity_id, b.display_name AS current_owner,
           s.display_name AS seller
    FROM deals d
    JOIN properties p USING (property_id)
    LEFT JOIN LATERAL (
      SELECT e.entity_id, e.display_name
      FROM deal_parties dp JOIN entities e USING (entity_id)
      WHERE dp.deal_id = d.deal_id AND dp.role = 'buyer'
      LIMIT 1
    ) b ON true
    LEFT JOIN LATERAL (
      SELECT e.display_name
      FROM deal_parties dp JOIN entities e USING (entity_id)
      WHERE dp.deal_id = d.deal_id AND dp.role = 'seller'
      LIMIT 1
    ) s ON true
    ORDER BY d.property_id, d.sale_date DESC NULLS LAST, d.created_at DESC
  )
  SELECT jsonb_build_object(
    'stats', jsonb_build_object(
      'deals', (SELECT count(*) FROM deals),
      'priced_deals', (SELECT count(*) FROM deals WHERE sale_price IS NOT NULL),
      'total_volume', (SELECT coalesce(sum(sale_price), 0) FROM deals),
      'unique_buyers', (SELECT count(DISTINCT entity_id) FROM deal_parties WHERE role='buyer'),
      'unique_sellers', (SELECT count(DISTINCT entity_id) FROM deal_parties WHERE role='seller'),
      'contacts', (SELECT count(*) FROM contacts),
      'contact_gaps', (SELECT count(*) FROM buyer_rollup WHERE deal_count >= 2 AND contact_count = 0),
      'open_reviews', (SELECT count(*) FROM review_queue WHERE status='open')
    ),
    'contact_gaps', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'entity_id', entity_id, 'name', name, 'deal_count', deal_count,
        'volume', volume, 'last_deal', last_deal, 'contact_count', contact_count
      ) ORDER BY volume DESC)
      FROM (SELECT * FROM buyer_rollup WHERE deal_count >= 2 AND contact_count = 0 ORDER BY volume DESC LIMIT 12) x
    ), '[]'::jsonb),
    'owner_targets', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'property_id', property_id, 'deal_id', deal_id, 'address', address,
        'borough', borough, 'market', market, 'bbl', bbl, 'sale_date', sale_date,
        'sale_price', sale_price, 'asset_type', asset_type, 'owner_entity_id', owner_entity_id,
        'current_owner', current_owner, 'known_owner', current_owner, 'seller', seller,
        'has_contact', EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id = owner_entity_id)
      ) ORDER BY sale_price DESC NULLS LAST)
      FROM (SELECT * FROM latest_deal ORDER BY sale_price DESC NULLS LAST LIMIT 12) x
    ), '[]'::jsonb),
    'review_items', coalesce((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC)
      FROM (SELECT review_id, object_type, object_id, issue_class, severity, payload, created_at
            FROM review_queue WHERE status='open' ORDER BY created_at DESC LIMIT 12) r
    ), '[]'::jsonb),
    'scrape_runs', coalesce((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.started_at DESC)
      FROM (SELECT run_id, job, started_at, finished_at, status, stats, error
            FROM scrape_runs ORDER BY started_at DESC LIMIT 12) s
    ), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION api_properties(
  q text DEFAULT NULL, borough text DEFAULT NULL, asset_type text DEFAULT NULL,
  contact_gap boolean DEFAULT false, page int DEFAULT 1, per_page int DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH latest AS (
    SELECT DISTINCT ON (d.property_id)
           d.property_id, d.deal_id, d.sale_date, d.sale_price, d.asset_type,
           p.address_raw AS address, p.address_norm, p.borough, p.market, p.zip, p.bbl,
           p.units AS property_units, p.sqft AS property_sqft,
           b.entity_id AS owner_entity_id, b.display_name AS current_owner,
           s.entity_id AS seller_entity_id, s.display_name AS seller
    FROM deals d
    JOIN properties p USING (property_id)
    LEFT JOIN LATERAL (
      SELECT e.entity_id, e.display_name
      FROM deal_parties dp JOIN entities e USING (entity_id)
      WHERE dp.deal_id=d.deal_id AND dp.role='buyer' LIMIT 1
    ) b ON true
    LEFT JOIN LATERAL (
      SELECT e.entity_id, e.display_name
      FROM deal_parties dp JOIN entities e USING (entity_id)
      WHERE dp.deal_id=d.deal_id AND dp.role='seller' LIMIT 1
    ) s ON true
    ORDER BY d.property_id, d.sale_date DESC NULLS LAST, d.created_at DESC
  ), f AS (
    SELECT l.*, EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id=l.owner_entity_id) AS has_contact,
           (SELECT max(i.occurred_at) FROM interactions i WHERE i.entity_id=l.owner_entity_id) AS last_interaction,
           (SELECT count(*) FROM deals d2 WHERE d2.property_id=l.property_id) AS deal_count
    FROM latest l
    WHERE (api_properties.q IS NULL OR api_properties.q = ''
           OR l.address ILIKE '%' || api_properties.q || '%'
           OR coalesce(l.bbl,'') ILIKE '%' || api_properties.q || '%'
           OR coalesce(l.current_owner,'') ILIKE '%' || api_properties.q || '%'
           OR coalesce(l.seller,'') ILIKE '%' || api_properties.q || '%')
      AND (api_properties.borough IS NULL OR api_properties.borough='' OR l.borough=api_properties.borough)
      AND (api_properties.asset_type IS NULL OR api_properties.asset_type='' OR l.asset_type=api_properties.asset_type)
      AND (NOT api_properties.contact_gap OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id=l.owner_entity_id))
  ), pg AS (
    SELECT * FROM f
    ORDER BY sale_price DESC NULLS LAST, sale_date DESC NULLS LAST
    LIMIT least(greatest(api_properties.per_page,1),200)
    OFFSET (greatest(api_properties.page,1)-1) * least(greatest(api_properties.per_page,1),200)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'page', greatest(api_properties.page,1),
    'per_page', least(greatest(api_properties.per_page,1),200),
    'properties', coalesce((SELECT jsonb_agg(to_jsonb(pg)) FROM pg), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION api_tasks(lim int DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH buyer_tasks AS (
    SELECT 'contact_gap'::text AS kind,
           CASE WHEN coalesce(sum(d.sale_price),0) >= 25000000 THEN 'high' ELSE 'normal' END AS priority,
           e.entity_id, NULL::uuid AS review_id,
           'Find phone/email for ' || e.display_name AS title,
           count(*)::text || ' buyer deals · last deal ' || coalesce(max(d.sale_date)::text, 'unknown') AS detail,
           coalesce(sum(d.sale_price),0) AS metric,
           max(d.sale_date)::timestamptz AS sort_time
    FROM deal_parties dp
    JOIN entities e USING (entity_id)
    JOIN deals d USING (deal_id)
    LEFT JOIN contacts c ON c.entity_id=e.entity_id
    WHERE dp.role='buyer'
    GROUP BY e.entity_id, e.display_name
    HAVING count(*) >= 2 AND count(c.contact_id)=0
  ), review_tasks AS (
    SELECT 'review'::text AS kind, coalesce(severity,'normal') AS priority,
           NULL::uuid AS entity_id, review_id,
           'Review ' || issue_class AS title,
           object_type || ' · ' || object_id AS detail,
           NULL::numeric AS metric,
           created_at AS sort_time
    FROM review_queue WHERE status='open'
  ), all_tasks AS (
    SELECT * FROM buyer_tasks UNION ALL SELECT * FROM review_tasks
  )
  SELECT jsonb_build_object('tasks', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'kind', kind, 'priority', priority, 'entity_id', entity_id,
      'review_id', review_id, 'title', title, 'detail', detail, 'metric', metric
    ) ORDER BY sort_time DESC NULLS LAST)
    FROM (SELECT * FROM all_tasks ORDER BY sort_time DESC NULLS LAST LIMIT least(greatest(api_tasks.lim,1),250)) x
  ), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_log_interaction(
  entity_id uuid, channel text DEFAULT 'other', subject text DEFAULT NULL,
  notes text DEFAULT NULL, outcome text DEFAULT NULL, user_id text DEFAULT 'broker')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE iid uuid;
BEGIN
  INSERT INTO interactions(entity_id, user_id, channel, occurred_at, subject, notes, outcome)
  VALUES (api_log_interaction.entity_id, coalesce(api_log_interaction.user_id,'broker'),
          coalesce(nullif(api_log_interaction.channel,''),'other'), now(),
          api_log_interaction.subject, api_log_interaction.notes, api_log_interaction.outcome)
  RETURNING interaction_id INTO iid;
  RETURN jsonb_build_object('interaction_id', iid, 'status', 'logged');
END;
$$;

CREATE OR REPLACE FUNCTION api_scraper_runs(lim int DEFAULT 75)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('runs', coalesce((
    SELECT jsonb_agg(to_jsonb(r) ORDER BY started_at DESC)
    FROM (SELECT run_id, job, started_at, finished_at, status, stats, error
          FROM scrape_runs ORDER BY started_at DESC LIMIT least(greatest(api_scraper_runs.lim,1),200)) r
  ), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_request_scrape(job text, user_id text DEFAULT 'broker', options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE rid uuid;
BEGIN
  IF job NOT IN ('traded_refresh','acris_refresh','crexi_refresh','property_owner_refresh','full_refresh') THEN
    RETURN jsonb_build_object('error','Unsupported scraper job');
  END IF;
  INSERT INTO scrape_runs(job, status, stats)
  VALUES (job, 'requested', jsonb_build_object('requested_by', coalesce(user_id,'broker'), 'options', coalesce(options,'{}'::jsonb)))
  RETURNING run_id INTO rid;
  RETURN jsonb_build_object('run_id', rid, 'job', job, 'status', 'requested');
END;
$$;

CREATE OR REPLACE FUNCTION api_upload_stage(
  filename text, user_id text DEFAULT 'broker', rows jsonb DEFAULT '[]'::jsonb,
  columns jsonb DEFAULT '[]'::jsonb, mapping jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid; idx int := 0; item jsonb;
BEGIN
  INSERT INTO uploads(user_id, filename, row_count, column_mapping, status)
  VALUES (coalesce(user_id,'broker'), filename, jsonb_array_length(coalesce(rows,'[]'::jsonb)), mapping, 'staged')
  RETURNING upload_id INTO uid;
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(rows,'[]'::jsonb)) LOOP
    INSERT INTO upload_rows(upload_id, row_num, raw) VALUES (uid, idx, item);
    idx := idx + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'upload_id', uid, 'row_count', idx, 'columns', coalesce(columns,'[]'::jsonb),
    'proposed_mapping', coalesce(mapping,'{}'::jsonb),
    'sample', (SELECT coalesce(jsonb_agg(raw ORDER BY row_num), '[]'::jsonb) FROM upload_rows WHERE upload_id=uid AND row_num < 5)
  );
END;
$$;

CREATE OR REPLACE FUNCTION api_upload_resolve(upload_id uuid, mapping jsonb DEFAULT '{}'::jsonb, user_id text DEFAULT 'broker')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; src_col text; canon text; entity_name text; person text; ph text; em text; mail text; ttl text; notes text; chan text; eid uuid; stats jsonb := '{"contacts_created":0,"interactions_created":0,"new_entity":0,"auto_matched":0,"needs_review":0,"skipped_no_name":0}'::jsonb;
BEGIN
  UPDATE uploads SET status='resolving', column_mapping=mapping WHERE uploads.upload_id=api_upload_resolve.upload_id;
  FOR r IN SELECT row_num, raw FROM upload_rows WHERE upload_rows.upload_id=api_upload_resolve.upload_id ORDER BY row_num LOOP
    entity_name := NULL; person := NULL; ph := NULL; em := NULL; mail := NULL; ttl := NULL; notes := NULL; chan := NULL;
    FOR src_col, canon IN SELECT key, value #>> '{}' FROM jsonb_each(mapping) LOOP
      IF canon='entity_name' THEN entity_name := r.raw->>src_col; END IF;
      IF canon='person_name' THEN person := r.raw->>src_col; END IF;
      IF canon='phone' THEN ph := r.raw->>src_col; END IF;
      IF canon='email' THEN em := r.raw->>src_col; END IF;
      IF canon='mailing_address' THEN mail := r.raw->>src_col; END IF;
      IF canon='title' THEN ttl := r.raw->>src_col; END IF;
      IF canon='interaction_notes' THEN notes := r.raw->>src_col; END IF;
      IF canon='channel' THEN chan := r.raw->>src_col; END IF;
    END LOOP;
    IF coalesce(trim(entity_name),'') = '' THEN
      stats := jsonb_set(stats, '{skipped_no_name}', to_jsonb((stats->>'skipped_no_name')::int + 1));
      UPDATE upload_rows SET status='rejected', resolution='{"reason":"missing entity_name"}'::jsonb WHERE upload_rows.upload_id=api_upload_resolve.upload_id AND row_num=r.row_num;
      CONTINUE;
    END IF;

    SELECT e.entity_id INTO eid FROM entities e
    WHERE e.norm_name = regexp_replace(upper(entity_name), '[^A-Z0-9]+', ' ', 'g')
    LIMIT 1;
    IF eid IS NULL THEN
      INSERT INTO entities(display_name, norm_name, entity_type)
      VALUES (entity_name, regexp_replace(upper(entity_name), '[^A-Z0-9]+', ' ', 'g'), 'unknown')
      RETURNING entity_id INTO eid;
      stats := jsonb_set(stats, '{new_entity}', to_jsonb((stats->>'new_entity')::int + 1));
    ELSE
      stats := jsonb_set(stats, '{auto_matched}', to_jsonb((stats->>'auto_matched')::int + 1));
    END IF;

    IF coalesce(ph,'') <> '' OR coalesce(em,'') <> '' OR coalesce(person,'') <> '' OR coalesce(mail,'') <> '' THEN
      INSERT INTO contacts(entity_id, person_name, title, phone, email, mailing_address, source, created_by)
      VALUES (eid, nullif(person,''), nullif(ttl,''), nullif(ph,''), nullif(em,''), nullif(mail,''), 'upload:' || api_upload_resolve.upload_id::text, coalesce(user_id,'broker'));
      stats := jsonb_set(stats, '{contacts_created}', to_jsonb((stats->>'contacts_created')::int + 1));
    END IF;
    IF coalesce(notes,'') <> '' THEN
      INSERT INTO interactions(entity_id, user_id, channel, occurred_at, subject, notes, outcome)
      VALUES (eid, coalesce(user_id,'broker'), coalesce(nullif(chan,''),'other'), now(), 'Uploaded contact note', notes, 'uploaded');
      stats := jsonb_set(stats, '{interactions_created}', to_jsonb((stats->>'interactions_created')::int + 1));
    END IF;
    UPDATE upload_rows SET status='imported', resolution=jsonb_build_object('entity_id', eid) WHERE upload_rows.upload_id=api_upload_resolve.upload_id AND row_num=r.row_num;
  END LOOP;
  UPDATE uploads SET status='imported' WHERE uploads.upload_id=api_upload_resolve.upload_id;
  RETURN jsonb_build_object('upload_id', api_upload_resolve.upload_id, 'stats', stats);
END;
$$;

GRANT EXECUTE ON FUNCTION api_workbench(), api_properties(text,text,text,boolean,int,int), api_tasks(int), api_log_interaction(uuid,text,text,text,text,text), api_scraper_runs(int), api_request_scrape(text,text,jsonb), api_upload_stage(text,text,jsonb,jsonb,jsonb), api_upload_resolve(uuid,jsonb,text) TO anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
