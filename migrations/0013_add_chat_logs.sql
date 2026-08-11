-- Migration 0013: Add chat_logs table and custom tpd_limit column to users table
--
-- 1. Add tpd_limit column to users table (default 10,000 Tokens Per Day)
-- 2. Create chat_logs table to record full prompt, response, and token metrics

ALTER TABLE users ADD COLUMN tpd_limit INTEGER NOT NULL DEFAULT 10000;

DROP TABLE IF EXISTS chat_logs;
CREATE TABLE IF NOT EXISTS chat_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  car_id     TEXT,
  prompt     TEXT NOT NULL,
  response   TEXT NOT NULL,
  in_tok     INTEGER NOT NULL DEFAULT 0,
  out_tok    INTEGER NOT NULL DEFAULT 0,
  total_tok  INTEGER NOT NULL DEFAULT 0,
  model      TEXT NOT NULL,
  day        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cl_uid ON chat_logs(uid);
CREATE INDEX IF NOT EXISTS idx_cl_day ON chat_logs(day);
