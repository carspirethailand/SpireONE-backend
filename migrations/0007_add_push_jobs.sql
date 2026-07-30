-- แจ้งเตือนตามเวลาที่นัดไว้ล่วงหน้า เช่น เตือนก่อนหมดเวลาจอด
CREATE TABLE IF NOT EXISTS push_jobs (
  id      TEXT PRIMARY KEY,
  uid     TEXT NOT NULL,
  send_at INTEGER NOT NULL,   -- epoch ms
  title   TEXT NOT NULL,
  body    TEXT NOT NULL DEFAULT '',
  url     TEXT NOT NULL DEFAULT '/',
  tag     TEXT NOT NULL DEFAULT 'spireone',
  done    INTEGER NOT NULL DEFAULT 0,
  t       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON push_jobs(done, send_at);
