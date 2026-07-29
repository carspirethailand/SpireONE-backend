-- Migration 0004: Shop catalogue (AI-sourced parts & accessories shown in the app)
CREATE TABLE IF NOT EXISTS shop (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  price TEXT,
  url TEXT,
  image TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
