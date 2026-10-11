-- Numeric email OTP. API never stores a raw code or writes secrets to logs.
CREATE TABLE IF NOT EXISTS auth_otp (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0, 1)),
  consumed_at INTEGER,
  invalidated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_otp_email ON auth_otp(email_key);
CREATE INDEX IF NOT EXISTS idx_auth_otp_expiry ON auth_otp(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate (
  k TEXT PRIMARY KEY,
  window_end INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0)
);
CREATE INDEX IF NOT EXISTS idx_auth_rate_expiry ON auth_rate(window_end);
