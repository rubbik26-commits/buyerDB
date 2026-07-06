-- 004: REST RPC API — the read endpoints as SECURITY DEFINER SQL functions,
-- callable through Supabase's built-in PostgREST gateway (/rest/v1/rpc/<fn>)
-- with the public anon key. This serves the static frontend without a separate
-- backend host. Response shapes are IDENTICAL to the FastAPI endpoints so the
-- same React views work against either. The Python-invariant write paths
-- (uploads, entity resolution, confirm_merge, AI agent) are NOT ported — the
-- FastAPI backend remains the only implementation of those.
-- RLS stays enabled on all tables; these functions are the deliberate,
-- read-only (plus review resolve/dismiss) public surface.

CREATE OR REPLACE FUNCTION api_health() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('status', 'ok', 'deals', (SELECT count(*) FROM deals));
$$;

CREATE OR REPLACE FUNCTION api_meta() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'asset_types', (SELECT coalesce(jsonb_agg(t ORDER BY t), '[]'::jsonb)
                    FROM (SELECT DISTINCT asset_type AS t FROM deals WHERE asset_type IS NOT NULL) x),
    'boroughs',    (SELECT coalesce(jsonb_agg(b ORDER BY b), '[]'::jsonb)
                    FROM (SELECT DISTINCT borough AS b FROM properties WHERE borough IS NOT NULL) x),
    'stats', (SELECT jsonb_build_object(
                'deals', count(*),
                'priced', count(*) FILTER (WHERE sale_price IS NOT NULL),
                'total_volume', coalesce(sum(sale_price), 0),
                'earliest', min(sale_date), 'latest', max(sale_date))
              FROM deals)
          || jsonb_build_object(
                'unique_buyers', (SELECT count(DISTINCT entity_id) FROM deal_parties WHERE role = 'buyer'),
                'open_reviews',  (SELECT count(*) FROM review_queue WHERE status = 'open'),
                'contacts',      (SELECT count(*) FROM contacts)));
$$;

CREATE OR REPLACE FUNCTION api_deals(
  q text DEFAULT NULL, borough text DEFAULT NULL, asset_type text DEFAULT NULL,
  market text DEFAULT NULL, price_min numeric DEFAULT NULL, price_max numeric DEFAULT NULL,
  date_min date DEFAULT NULL, date_max date DEFAULT NULL,
  units_min int DEFAULT NULL, units_max int DEFAULT NULL,
  sqft_min int DEFAULT NULL, sqft_max int DEFAULT NULL,
  ppsf_max numeric DEFAULT NULL, confidence_min int DEFAULT NULL,
  status text DEFAULT NULL, has_buyer boolean DEFAULT false,
  sort_by text DEFAULT 'sale_date', order_dir text DEFAULT 'desc',
  page int DEFAULT 1, per_page int DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH f AS (
    SELECT d.deal_id, d.sale_date, p.address_raw AS address, p.borough AS boro,
           p.market AS mkt, d.asset_type AS atype, b.display_name AS buyer,
           s.display_name AS seller, d.sale_price, d.units, d.sqft, d.ppu, d.ppsf,
           d.confidence, d.parse_status, d.source_url, d.source_system,
           CASE api_deals.sort_by
             WHEN 'sale_date'  THEN extract(epoch FROM d.sale_date)
             WHEN 'sale_price' THEN d.sale_price
             WHEN 'units'      THEN d.units
             WHEN 'sqft'       THEN d.sqft
             WHEN 'ppsf'       THEN d.ppsf
             WHEN 'ppu'        THEN d.ppu
             WHEN 'confidence' THEN d.confidence
             WHEN 'address'    THEN NULL
             ELSE extract(epoch FROM d.sale_date) END AS sort_num,
           CASE WHEN api_deals.sort_by = 'address' THEN p.address_raw END AS sort_text
    FROM deals d
    JOIN properties p USING (property_id)
    LEFT JOIN LATERAL (
      SELECT e.display_name FROM deal_parties dp JOIN entities e USING (entity_id)
      WHERE dp.deal_id = d.deal_id AND dp.role = 'buyer' LIMIT 1) b ON true
    LEFT JOIN LATERAL (
      SELECT e.display_name FROM deal_parties dp JOIN entities e USING (entity_id)
      WHERE dp.deal_id = d.deal_id AND dp.role = 'seller' LIMIT 1) s ON true
    WHERE (api_deals.q IS NULL OR api_deals.q = ''
           OR p.address_raw ILIKE '%' || api_deals.q || '%'
           OR b.display_name ILIKE '%' || api_deals.q || '%'
           OR s.display_name ILIKE '%' || api_deals.q || '%')
      AND (api_deals.borough IS NULL OR api_deals.borough = '' OR p.borough = api_deals.borough)
      AND (api_deals.asset_type IS NULL OR api_deals.asset_type = '' OR d.asset_type = api_deals.asset_type)
      AND (api_deals.market IS NULL OR api_deals.market = '' OR p.market = api_deals.market)
      AND (api_deals.price_min IS NULL OR d.sale_price >= api_deals.price_min)
      AND (api_deals.price_max IS NULL OR d.sale_price <= api_deals.price_max)
      AND (api_deals.date_min IS NULL OR d.sale_date >= api_deals.date_min)
      AND (api_deals.date_max IS NULL OR d.sale_date <= api_deals.date_max)
      AND (api_deals.units_min IS NULL OR d.units >= api_deals.units_min)
      AND (api_deals.units_max IS NULL OR d.units <= api_deals.units_max)
      AND (api_deals.sqft_min IS NULL OR d.sqft >= api_deals.sqft_min)
      AND (api_deals.sqft_max IS NULL OR d.sqft <= api_deals.sqft_max)
      AND (api_deals.ppsf_max IS NULL OR d.ppsf <= api_deals.ppsf_max)
      AND (api_deals.confidence_min IS NULL OR d.confidence >= api_deals.confidence_min)
      AND (api_deals.status IS NULL OR api_deals.status = '' OR d.parse_status = api_deals.status)
      AND (NOT api_deals.has_buyer OR b.display_name IS NOT NULL)
  ),
  pg AS (
    SELECT *, row_number() OVER (
      ORDER BY
        CASE WHEN api_deals.order_dir = 'asc'  THEN sort_num  END ASC  NULLS LAST,
        CASE WHEN api_deals.order_dir <> 'asc' THEN sort_num  END DESC NULLS LAST,
        CASE WHEN api_deals.order_dir = 'asc'  THEN sort_text END ASC  NULLS LAST,
        CASE WHEN api_deals.order_dir <> 'asc' THEN sort_text END DESC NULLS LAST,
        deal_id
    ) AS rn
    FROM f
    ORDER BY rn
    LIMIT least(greatest(api_deals.per_page, 1), 200)
    OFFSET (greatest(api_deals.page, 1) - 1) * least(greatest(api_deals.per_page, 1), 200)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'page', greatest(api_deals.page, 1),
    'per_page', least(greatest(api_deals.per_page, 1), 200),
    'pulse', (SELECT jsonb_build_object('n', count(*), 'vol', coalesce(sum(sale_price), 0),
                'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY sale_price))
              FROM f WHERE sale_price IS NOT NULL),
    'deals', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'deal_id', deal_id, 'sale_date', sale_date, 'address', address,
                'borough', boro, 'market', mkt, 'asset_type', atype,
                'buyer', buyer, 'seller', seller, 'sale_price', sale_price,
                'units', units, 'sqft', sqft, 'ppu', ppu, 'ppsf', ppsf,
                'confidence', confidence, 'parse_status', parse_status,
                'source_url', source_url, 'source_system', source_system)
              ORDER BY rn), '[]'::jsonb) FROM pg));
$$;

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
           bool_or(c.contact_id IS NOT NULL) AS has_contact
    FROM deal_parties dp
    JOIN entities e USING (entity_id)
    JOIN deals d USING (deal_id)
    JOIN properties p USING (property_id)
    LEFT JOIN contacts c ON c.entity_id = e.entity_id
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

CREATE OR REPLACE FUNCTION api_leaderboards(
  group_by text DEFAULT 'asset_type', rank_by text DEFAULT 'count', top int DEFAULT 5)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH g AS (
    SELECT CASE WHEN api_leaderboards.group_by = 'borough' THEN p.borough ELSE d.asset_type END AS grp,
           e.display_name AS name, count(*) AS n, coalesce(sum(d.sale_price), 0) AS vol
    FROM deal_parties dp JOIN entities e USING (entity_id)
    JOIN deals d USING (deal_id) JOIN properties p USING (property_id)
    WHERE dp.role = 'buyer'
      AND (CASE WHEN api_leaderboards.group_by = 'borough' THEN p.borough ELSE d.asset_type END) IS NOT NULL
    GROUP BY 1, 2
  ),
  r AS (
    SELECT grp, name, n, vol,
           row_number() OVER (PARTITION BY grp ORDER BY
             CASE WHEN api_leaderboards.rank_by = 'vol' THEN vol ELSE n END DESC) AS rk
    FROM g
  )
  SELECT jsonb_build_object('boards', coalesce(
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY grp, rk) FROM r
     WHERE rk <= least(greatest(api_leaderboards.top, 1), 25)), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_entity(eid uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM entities WHERE entity_id = eid)
    THEN jsonb_build_object('error', 'not found')
    ELSE jsonb_build_object(
      'entity', (SELECT to_jsonb(e) FROM entities e WHERE e.entity_id = eid),
      'deals', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'role', dp.role, 'sale_date', d.sale_date, 'address', p.address_raw,
            'borough', p.borough, 'asset_type', d.asset_type,
            'sale_price', d.sale_price, 'source_url', d.source_url)
          ORDER BY d.sale_date DESC NULLS LAST)
        FROM deal_parties dp JOIN deals d USING (deal_id) JOIN properties p USING (property_id)
        WHERE dp.entity_id = eid), '[]'::jsonb),
      'contacts', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'contact_id', contact_id, 'person_name', person_name, 'phone', phone,
            'email', email, 'mailing_address', mailing_address, 'source', source))
        FROM contacts WHERE entity_id = eid), '[]'::jsonb))
  END;
$$;

CREATE OR REPLACE FUNCTION api_review(
  status text DEFAULT 'open', issue_class text DEFAULT NULL, lim int DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at DESC) FROM (
        SELECT review_id, object_type, object_id, r.issue_class, severity, payload, created_at
        FROM review_queue r
        WHERE r.status = coalesce(nullif(api_review.status, ''), 'open')
          AND (api_review.issue_class IS NULL OR api_review.issue_class = ''
               OR r.issue_class = api_review.issue_class)
        ORDER BY created_at DESC
        LIMIT least(greatest(api_review.lim, 1), 200)) i), '[]'::jsonb),
    'open_counts', coalesce((SELECT jsonb_object_agg(issue_class, n) FROM (
        SELECT r2.issue_class, count(*) AS n FROM review_queue r2
        WHERE r2.status = 'open' GROUP BY r2.issue_class) c), '{}'::jsonb));
$$;

-- resolve/dismiss only. confirm_merge (alias write + contact import) stays in the
-- FastAPI backend — it depends on the Python normalize/import functions.
CREATE OR REPLACE FUNCTION api_review_act(
  review_id uuid, action text, user_id text DEFAULT 'system')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF action = 'resolve' OR action = 'dismiss' THEN
    UPDATE review_queue
    SET status = CASE WHEN action = 'resolve' THEN 'resolved' ELSE 'dismissed' END,
        resolved_by = coalesce(user_id, 'system'), resolved_at = now()
    WHERE review_queue.review_id = api_review_act.review_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'review item not found'); END IF;
    RETURN jsonb_build_object('status', CASE WHEN action = 'resolve' THEN 'resolved' ELSE 'dismissed' END);
  END IF;
  RETURN jsonb_build_object('error',
    'confirm_merge requires the FastAPI backend (entity resolution runs in Python).');
END;
$$;

CREATE OR REPLACE FUNCTION api_uploads_list() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('uploads', coalesce((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC)
    FROM (SELECT upload_id, filename, row_count, status, created_at
          FROM uploads ORDER BY created_at DESC LIMIT 50) u), '[]'::jsonb));
$$;

GRANT EXECUTE ON FUNCTION api_health(), api_meta(),
  api_deals(text,text,text,text,numeric,numeric,date,date,int,int,int,int,numeric,int,text,boolean,text,text,int,int),
  api_buyers(text,text,numeric,numeric,date,int,text,int),
  api_leaderboards(text,text,int), api_entity(uuid),
  api_review(text,text,int), api_review_act(uuid,text,text), api_uploads_list()
TO anon;

NOTIFY pgrst, 'reload schema';
