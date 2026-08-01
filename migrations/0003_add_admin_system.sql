-- Migration 0003: Add Admin and Security tables (config, audit, usage)
-- ALTER TABLE users ADD COLUMN created_at INTEGER; (Already exists on remote table)
-- ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0; (Already exists on remote table)

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  uid TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (uid, day)
);
