-- นิตยสารแบบช่องเลื่อน 20 ช่อง: เก็บพาดหัวต้นฉบับแบบย่อไว้กันข่าวเดิมเข้าซ้ำ
-- worker เพิ่มคอลัมน์ให้เองตอน deploy (SCHEMA_VERSION 18) ไฟล์นี้มีไว้ให้รันมือได้ถ้าต้องการ
ALTER TABLE magazine ADD COLUMN src_key TEXT;
