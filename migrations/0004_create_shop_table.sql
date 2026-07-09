DROP TABLE IF EXISTS shop_items;
CREATE TABLE shop_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    short_description TEXT,
    price TEXT,
    make TEXT,
    model TEXT,
    image_url TEXT,
    type TEXT,
    created_at INTEGER NOT NULL
);
