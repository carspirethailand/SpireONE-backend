-- นิตยสารแบบรวมข่าวจากแหล่งข่าวจริง (src/news.js)
-- worker เพิ่มคอลัมน์ให้เองตอน deploy (SCHEMA_VERSION 16) ไฟล์นี้มีไว้ให้รันมือได้ถ้าต้องการ
ALTER TABLE magazine ADD COLUMN source TEXT;        -- ชื่อสำนักข่าว
ALTER TABLE magazine ADD COLUMN url TEXT;           -- ลิงก์ต้นฉบับ
ALTER TABLE magazine ADD COLUMN image TEXT;         -- รูปปก (https)
ALTER TABLE magazine ADD COLUMN published_at INTEGER;
ALTER TABLE magazine ADD COLUMN origin TEXT;        -- feed | ai | manual (manual ไม่ถูกลบตอนอัปเดต)
ALTER TABLE magazine ADD COLUMN points TEXT;        -- JSON array ประเด็นสำคัญ
ALTER TABLE magazine ADD COLUMN sort INTEGER;       -- ลำดับแสดงผล (ข่าวเด่นสุด = 1)
