-- สีรถและประเภทตัวถังในการาจ (ภาพรถในแอปลงสีตามค่านี้)
-- worker เพิ่มคอลัมน์ให้เองตอน deploy (SCHEMA_VERSION 17) ไฟล์นี้มีไว้ให้รันมือได้ถ้าต้องการ
ALTER TABLE cars ADD COLUMN color TEXT;   -- #RRGGBB
ALTER TABLE cars ADD COLUMN body TEXT;    -- sedan | hatchback | suv | pickup | mpv | van | coupe | ev
