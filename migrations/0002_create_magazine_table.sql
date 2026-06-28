-- Migration to create magazine table in Cloudflare D1
CREATE TABLE IF NOT EXISTS magazine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  short_description TEXT,
  full_description TEXT,
  type TEXT,
  created_at INTEGER NOT NULL
);
