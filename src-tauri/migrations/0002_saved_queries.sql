CREATE TABLE IF NOT EXISTS saved_queries (
    id            TEXT PRIMARY KEY NOT NULL,
    profile_id    TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE ON UPDATE CASCADE,
    title         TEXT NOT NULL,
    driver        TEXT NOT NULL,
    database_name TEXT,
    schema_name   TEXT,
    sql_text      TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    sort_order    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_profile_id
ON saved_queries(profile_id, sort_order, updated_at);
