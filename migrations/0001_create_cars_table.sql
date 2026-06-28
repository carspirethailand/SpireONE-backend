-- Migration to create cars table in Cloudflare D1
CREATE TABLE IF NOT EXISTS cars (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year TEXT,
  mileage TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);
