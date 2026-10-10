-- Private per-account onboarding. Apply this entire migration atomically before
-- accepting new /api/state writes; src/onboarding.js exports the identical DDL.
CREATE TABLE IF NOT EXISTS user_onboarding (
  uid TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  consented_at INTEGER,
  tutorial_status TEXT NOT NULL DEFAULT 'pending' CHECK(tutorial_status IN ('pending','completed','skipped')),
  tutorial_finished_at INTEGER,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1))
);
INSERT INTO config (key,value) VALUES ('onboarding_rollout_at', CAST(CAST(strftime('%s','now') AS INTEGER)*1000 AS TEXT))
  ON CONFLICT(key) DO NOTHING;
INSERT INTO user_onboarding (uid,profile,completed_at,terms_version,privacy_version,consented_at,tutorial_status,tutorial_finished_at,legacy)
  SELECT u.uid,s.v,s.t,'legacy-pre-onboarding','legacy-pre-onboarding',NULL,'skipped',s.t,1
  FROM users u JOIN user_state s ON s.uid=u.uid AND s.k='setup'
  WHERE NOT EXISTS (SELECT 1 FROM config WHERE key='onboarding_seed_done')
    AND u.created_at IS NOT NULL AND u.created_at>0
    AND u.created_at<CAST((SELECT value FROM config WHERE key='onboarding_rollout_at') AS INTEGER)
    AND s.t>0 AND s.t<=CAST((SELECT value FROM config WHERE key='onboarding_rollout_at') AS INTEGER)
    AND CASE WHEN json_valid(s.v) THEN json_type(s.v)='object'
      AND json_extract(s.v,'$.v')=3
      AND json_extract(s.v,'$.level') IN ('basic','advance','enthusiast')
      AND (json_extract(s.v,'$.uid') IS NULL OR json_extract(s.v,'$.uid')=u.uid)
      ELSE 0 END
  ON CONFLICT(uid) DO NOTHING;
INSERT INTO config (key,value) SELECT 'onboarding_seed_done',value FROM config WHERE key='onboarding_rollout_at'
  ON CONFLICT(key) DO NOTHING;
