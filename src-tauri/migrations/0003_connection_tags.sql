ALTER TABLE connections
ADD COLUMN tag_label TEXT NOT NULL DEFAULT '';

ALTER TABLE connections
ADD COLUMN tag_color TEXT;
