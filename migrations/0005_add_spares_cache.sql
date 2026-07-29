-- Migration 0005: cache for AI-matched spares so a repeat visit costs no quota
CREATE TABLE IF NOT EXISTS spares_cache (
  k TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  payload TEXT NOT NULL,
  t INTEGER NOT NULL
);
