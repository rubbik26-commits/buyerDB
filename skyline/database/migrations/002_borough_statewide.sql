-- 002: properties.borough is NY-state-wide (Nassau, Suffolk, upstate counties appear
-- in the canonical dataset — 26 rows verified 2026-07-02). The five-borough CHECK
-- encoded a wrong assumption. NYC-borough validation for ACRIS operations remains in
-- the ingest code (BOROUGH_CODE), where it belongs.
ALTER TABLE properties DROP CONSTRAINT properties_borough_check;
