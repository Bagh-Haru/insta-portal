ALTER TABLE publications ADD COLUMN creative_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE publication_media ADD COLUMN creative_json TEXT NOT NULL DEFAULT '{}';
