-- การแจ้งเตือนผ่านเว็บ: หนึ่งแถวต่อหนึ่งเครื่องที่ผู้ใช้กดอนุญาตไว้
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  uid      TEXT NOT NULL,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  cars     TEXT NOT NULL DEFAULT '[]',  -- วันครบกำหนดที่ซิงก์มาจากเครื่อง
  lang     TEXT NOT NULL DEFAULT 'th',
  sent     TEXT NOT NULL DEFAULT '{}',  -- กันส่งซ้ำเรื่องเดิมในวันเดียวกัน
  t        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_uid ON push_subs(uid);
