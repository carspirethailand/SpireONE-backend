-- ══════════════════════════════════════════════════════════════════
-- สามชั้นที่ทำให้ระบบไมล์ใช้งานได้จริงโดยผู้ใช้แทบไม่ต้องทำอะไร
--   1. เพดานแจ้งเตือน  — กันคนเมินจนปิด noti ซึ่งเท่ากับเสียผู้ใช้ถาวร
--   2. LINE            — ส่งถึงทุกเครื่องโดยไม่ต้องติดตั้ง PWA
--                        และรับใบเสร็จที่ forward เข้ามาเป็นจุดยืนยัน
--   3. OBD dongle      — รถรายงานเลขไมล์ตัวเองตรงเข้าเซิร์ฟเวอร์ ไม่ผ่านมือถือ
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. เพดานแจ้งเตือนต่อรถหนึ่งคัน ───
-- ทุกช่องทาง (Web Push / LINE) ใช้เพดานเดียวกัน ไม่งั้นผู้ใช้ได้สองต่อ
-- เหตุการณ์จริงของรถหนึ่งคันมีราว 5-7 ครั้งต่อปี ถ้าส่งมากกว่านั้น
-- แปลว่าดีไซน์ผิด ไม่ใช่ผู้ใช้ผิด
CREATE TABLE IF NOT EXISTS notify_state (
  car_id      TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  last_at     INTEGER,             -- ส่งครั้งล่าสุดเมื่อไร (epoch ms)
  last_digest TEXT DEFAULT '',     -- ส่งเรื่องอะไรไปบ้าง กันส่งซ้ำเนื้อเดิม
  sent_30d    INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER              -- ผู้ใช้ขอพักเตือนชั่วคราว
);
CREATE INDEX IF NOT EXISTS idx_notify_uid ON notify_state(uid);

-- ─── 2. ผูกบัญชี LINE ───
-- ผู้ใช้ทักบอทด้วยรหัส 6 ตัวที่เห็นในแอปครั้งเดียว จบ
-- จากนั้นได้แจ้งเตือนทาง LINE และ forward ใบเสร็จเข้ามาได้ตลอด
CREATE TABLE IF NOT EXISTS line_link (
  line_uid  TEXT PRIMARY KEY,      -- userId ที่ LINE ออกให้ (ต่อ channel)
  uid       TEXT NOT NULL,         -- uid ฝั่ง SpireONE (Firebase)
  lang      TEXT NOT NULL DEFAULT 'th',
  active    INTEGER NOT NULL DEFAULT 1,
  linked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_line_uid ON line_link(uid);

-- รหัสผูกบัญชีอายุสั้น — หมดอายุแล้วใช้ไม่ได้ ป้องกันคนเดารหัสไปผูกมั่ว
CREATE TABLE IF NOT EXISTS line_code (
  code       TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- ─── 3. อุปกรณ์ OBD ───
-- dongle ที่มีซิมของตัวเองยิง HTTP/MQTT เข้ามาตรง ๆ ไม่ผ่านมือถือเลย
-- เสียบครั้งเดียวแล้วไม่ต้องแตะอีก — zero effort ของจริง
CREATE TABLE IF NOT EXISTS obd_device (
  device_id  TEXT PRIMARY KEY,     -- IMEI หรือรหัสที่เราออกให้
  uid        TEXT NOT NULL,
  car_id     TEXT NOT NULL,
  secret     TEXT NOT NULL,        -- ใช้เซ็น HMAC ทุกครั้งที่ส่งข้อมูล
  -- OBD-II มาตรฐานไม่มี PID เลขไมล์รวมทุกรุ่น หลายคันอ่านได้แค่ระยะสะสม
  -- จึงเก็บค่าตั้งต้นไว้ แล้วบวกระยะที่ dongle รายงานเข้าไป
  base_km    INTEGER,              -- เลขไมล์จริงตอนติดตั้ง
  base_dist  INTEGER,              -- ค่าระยะสะสมของ dongle ณ ตอนนั้น
  last_seen  INTEGER,
  last_km    INTEGER,
  t          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obd_car ON obd_device(car_id);
CREATE INDEX IF NOT EXISTS idx_obd_uid ON obd_device(uid);
