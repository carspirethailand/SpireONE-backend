-- คลังสเปกรถ (src/carspec.js) + ข้อมูลเพิ่มเติมของรถ (src/vin.js)
-- worker สร้างให้เองตอน deploy (SCHEMA_VERSION 19) ไฟล์นี้มีไว้ให้รันมือได้ถ้าต้องการ
ALTER TABLE cars ADD COLUMN info TEXT;   -- JSON: vin, trim, engine, gear, fuel, plate, province, tax_due, ins_due, ins_co, tire, note
CREATE TABLE IF NOT EXISTS car_specs (
  k TEXT PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL, year TEXT NOT NULL,
  status TEXT NOT NULL,                  -- pending | ready | notfound | failed | verified
  body TEXT, data TEXT, sources TEXT, models TEXT, error TEXT,
  hits INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, by_uid TEXT
);
CREATE TABLE IF NOT EXISTS car_spec_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, note TEXT, who TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_specrep_k ON car_spec_reports(k);
CREATE TABLE IF NOT EXISTS spec_quota (who TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (who, day));
