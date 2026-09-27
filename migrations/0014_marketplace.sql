-- Separate tables; never exposes technician applications through the public directory.
CREATE TABLE IF NOT EXISTS tech_applications (
 uid TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS technicians (
 id TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
 test INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tech_jobs (
 id TEXT PRIMARY KEY, customer TEXT NOT NULL, technician TEXT NOT NULL,
 tech_id TEXT NOT NULL, status TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0,
 data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tech_jobs_customer ON tech_jobs(customer,updated_at);
CREATE INDEX IF NOT EXISTS tech_jobs_technician ON tech_jobs(technician,updated_at);
CREATE INDEX IF NOT EXISTS tech_jobs_stats ON tech_jobs(tech_id,status);
