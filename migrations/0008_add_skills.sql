-- Skills — คำสั่งสำเร็จรูปที่ผู้ใช้เขียนเองแล้วเรียกด้วย /ชื่อ
-- body คือข้อความคำสั่งที่จะถูกแนบไปกับคำถามตอนเรียกใช้
-- status: private (เห็นคนเดียว) · pending (รออนุมัติ) · public (เผยแพร่แล้ว) · rejected
CREATE TABLE IF NOT EXISTS skills (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'private',
  reason     TEXT NOT NULL DEFAULT '',
  installs   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skills_uid    ON skills(uid);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
-- slug ต้องไม่ซ้ำเฉพาะในกลุ่มที่เผยแพร่แล้ว ของส่วนตัวซ้ำกันได้
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_public_slug
  ON skills(slug) WHERE status = 'public';

-- ให้ดาวได้คนละหนึ่งครั้งต่อสกิล แก้คะแนนเดิมได้ แต่โหวตซ้ำเพื่อดันคะแนนไม่ได้
CREATE TABLE IF NOT EXISTS skill_stars (
  skill_id TEXT NOT NULL,
  uid      TEXT NOT NULL,
  stars    INTEGER NOT NULL,
  t        INTEGER NOT NULL,
  PRIMARY KEY (skill_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_stars_skill ON skill_stars(skill_id);
