-- Migration 0011: shared part-price table, refreshed weekly by cron
--
-- Why a new table instead of reusing spares_cache: spares_cache is keyed per
-- uid, so the hundredth owner of a Triton still burns AI quota for prices that
-- are identical for everyone. Part prices are a property of the car model, not
-- of the user, so they belong in one shared row that every user reads.
--
-- The Sunday cron fills this from one AI call per car model (12 parts in a
-- single reply), which is why /api/spares can then answer with no AI at all.

CREATE TABLE IF NOT EXISTS part_prices (
  -- 'mitsubishi|triton|2015-2023|brakepad' — lowercased, so lookups are exact
  k         TEXT PRIMARY KEY,
  make      TEXT NOT NULL,
  model     TEXT NOT NULL,
  -- inclusive generation range; a 2019 Triton reads the 2015-2023 row
  year_lo   INTEGER,
  year_hi   INTEGER,
  -- catalogue key from the front end: engineoil, oilfilter, brakepad, ...
  part      TEXT NOT NULL,
  lo        INTEGER,             -- price floor, whole units of `currency`
  hi        INTEGER,             -- price ceiling
  currency  TEXT NOT NULL DEFAULT 'THB',
  -- 'ai' | 'ebay' | 'manual' — manual rows are hand-corrected and the weekly
  -- job must leave them alone, otherwise a fix gets overwritten every Sunday
  src       TEXT NOT NULL DEFAULT 'ai',
  -- how much to trust the row: 0-100. The AI job writes its own confidence so
  -- the UI can hide a wild guess instead of showing it as a real price
  conf      INTEGER NOT NULL DEFAULT 60,
  samples   INTEGER NOT NULL DEFAULT 0,   -- listings the estimate was based on
  note      TEXT,
  t         INTEGER NOT NULL              -- last update, ms since epoch
);

-- Reading path: "give me every price for this car model"
CREATE INDEX IF NOT EXISTS idx_pp_model ON part_prices(make, model);
-- Writing path: "which rows are stale enough to refresh this Sunday"
CREATE INDEX IF NOT EXISTS idx_pp_t     ON part_prices(t);
-- Cross-model comparison, e.g. sanity-checking a brake pad price against the
-- median of all brake pad rows before accepting it
CREATE INDEX IF NOT EXISTS idx_pp_part  ON part_prices(part);


-- Bookkeeping for the weekly job so a crashed run does not redo finished work
-- and so a model that keeps failing can be backed off instead of retried
-- forever. One row per car model.
CREATE TABLE IF NOT EXISTS part_price_runs (
  k         TEXT PRIMARY KEY,    -- 'mitsubishi|triton'
  last_ok   INTEGER,             -- last successful refresh, ms
  last_try  INTEGER,             -- last attempt, ms
  fails     INTEGER NOT NULL DEFAULT 0,
  err       TEXT
);
