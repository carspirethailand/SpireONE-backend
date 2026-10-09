-- บทสนทนากับ AI ในแชต LINE (จำ 8 ข้อความล่าสุดต่อ LINE หนึ่งคน · n = จำนวนคำถามของวัน day)
-- worker สร้างให้เองตอน deploy (SCHEMA_VERSION 15) ไฟล์นี้มีไว้ให้รันมือได้ถ้าต้องการ
CREATE TABLE IF NOT EXISTS line_chat (
  line_uid   TEXT PRIMARY KEY,
  history    TEXT NOT NULL DEFAULT '[]',
  day        TEXT NOT NULL DEFAULT '',
  n          INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
