-- โควตาเดิมนับเป็น "จำนวนครั้ง" ซึ่งไม่ตรงกับต้นทุนจริง
-- ข้อความสั้นกับข้อความยาวคิดเท่ากันหมด ทั้งที่ต่างกันหลายสิบเท่า
-- เก็บ token จริงที่โมเดลรายงานกลับมาแทน แยกขาเข้ากับขาออก
-- เพราะสองขานี้ราคาต่างกันมากในทุกผู้ให้บริการ
ALTER TABLE usage ADD COLUMN in_tok  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN out_tok INTEGER NOT NULL DEFAULT 0;

-- ค่าที่ผู้ใช้ตั้งเองสำหรับห้องแชทโดยเฉพาะ แยกจากการตั้งค่าโปรไฟล์
-- เก็บเป็น JSON ก้อนเดียวเพื่อให้เพิ่มตัวเลือกใหม่ได้โดยไม่ต้อง migrate อีก
CREATE TABLE IF NOT EXISTS chat_prefs (
  uid   TEXT PRIMARY KEY,
  prefs TEXT NOT NULL,
  t     INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);
