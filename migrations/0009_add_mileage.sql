-- ══════════════════════════════════════════════════════════════════
-- ระบบประเมินเลขไมล์อัตโนมัติ + เตือนบำรุงรักษาตามระยะ
--
-- แนวคิด: เว็บแอปอ่านเซนเซอร์เบื้องหลังไม่ได้ จึงไม่ "วัด" ระยะทาง
-- แต่ "เรียนรู้อัตราการขับ" ของรถแต่ละคันจากจุดยืนยันจริง แล้วเดินเลข
-- ต่อเองที่เซิร์ฟเวอร์ทุกวัน พร้อมบอกความไม่แน่นอนตรง ๆ ไม่แกล้งแม่น
-- ══════════════════════════════════════════════════════════════════

-- ─── จุดยืนยันเลขไมล์ ───
-- หนึ่งแถว = หนึ่งครั้งที่ "รู้เลขไมล์จริง" ไม่ใช่ค่าประมาณ
-- ยิ่งมีหลายจุด ยิ่งคำนวณอัตราการขับได้แม่น
CREATE TABLE IF NOT EXISTS odo_anchor (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  car_id      TEXT NOT NULL,
  km          INTEGER NOT NULL,
  -- receipt = อ่านจากใบเสร็จอู่ (อัตโนมัติ ไม่รบกวนผู้ใช้)
  -- confirm = ผู้ใช้กดยืนยันจากการแจ้งเตือน
  -- fuel    = คำนวณจากลิตรที่เติม × อัตราสิ้นเปลืองของรุ่น
  -- obd     = อ่านจาก ECU ผ่าน dongle
  -- signup  = เลขที่กรอกตอนเพิ่มรถ
  -- manual  = แก้เลขไมล์เองในการาจ
  source      TEXT NOT NULL,
  -- เวลาที่เลขนี้ "เป็นจริง" ไม่ใช่เวลาที่บันทึก — ใบเสร็จเก่าย้อนหลังได้
  observed_at INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  t           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchor_car ON odo_anchor(car_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_anchor_uid ON odo_anchor(uid);
-- ใบเสร็จใบเดิมถูกสแกนซ้ำได้ กันไม่ให้กลายเป็นจุดยืนยันซ้ำซ้อน
CREATE UNIQUE INDEX IF NOT EXISTS idx_anchor_dedup
  ON odo_anchor(car_id, source, km, observed_at);

-- ─── สถานะประมาณการปัจจุบัน (หนึ่งแถวต่อรถ) ───
CREATE TABLE IF NOT EXISTS odo_state (
  car_id     TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  est_km     REAL NOT NULL,          -- ค่าประมาณล่าสุดที่เซิร์ฟเวอร์เดินให้
  km_per_day REAL NOT NULL,          -- อัตราที่เรียนรู้ได้
  sigma_km   REAL NOT NULL DEFAULT 0,-- ความไม่แน่นอน ±  (โตตามเวลาที่ไม่มี anchor)
  anchor_km  INTEGER,                -- จุดยืนยันล่าสุดที่ใช้เป็นฐาน
  anchor_at  INTEGER,
  n_anchor   INTEGER NOT NULL DEFAULT 0,
  -- lifetime = ยังมีจุดเดียว ใช้ค่าเฉลี่ยทั้งชีวิตรถจากปีรถ
  -- learned  = มีตั้งแต่สองจุด คำนวณจากพฤติกรรมจริงของคันนี้
  rate_basis TEXT NOT NULL DEFAULT 'lifetime',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_uid ON odo_state(uid);

-- ─── รายการบำรุงรักษาตามระยะ ───
-- interval_months รองรับอะไหล่ที่ครบตามอายุแม้ไมล์น้อย และเป็นตัวกันเหนียว
-- ช่วงที่ค่าประมาณไมล์ยังหยาบ — เวลาไม่ต้องเดา รู้แน่นอนเสมอ
CREATE TABLE IF NOT EXISTS maint_item (
  id              TEXT PRIMARY KEY,
  uid             TEXT NOT NULL,
  car_id          TEXT NOT NULL,
  part            TEXT NOT NULL,
  interval_km     INTEGER,
  interval_months INTEGER,
  last_km         INTEGER,
  last_at         INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- กันเตือนซ้ำเรื่องเดิม: จำว่าเตือนไปแล้วที่ระยะ/เวลาไหน
  notified_km     INTEGER,
  notified_at     INTEGER,
  t               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maint_car ON maint_item(car_id, enabled);
CREATE INDEX IF NOT EXISTS idx_maint_uid ON maint_item(uid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_part ON maint_item(car_id, part);
