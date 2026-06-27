-- Migration to create users table in Cloudflare D1
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  photo TEXT,
  role TEXT DEFAULT 'user',
  last_login INTEGER NOT NULL
);
