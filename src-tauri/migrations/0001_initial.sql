CREATE TABLE IF NOT EXISTS connection_folders (
    id         TEXT    PRIMARY KEY NOT NULL,
    name       TEXT    NOT NULL,
    parent_id  TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    sort_order INTEGER,
    FOREIGN KEY (parent_id) REFERENCES connection_folders(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connection_folders_parent_id
ON connection_folders(parent_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS connections (
    id          TEXT    PRIMARY KEY NOT NULL,
    name        TEXT    NOT NULL,
    driver      TEXT    NOT NULL,
    environment TEXT    NOT NULL DEFAULT 'development',
    color       TEXT,
    payload     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    last_connected_at      INTEGER,
    last_connection_status TEXT CHECK (last_connection_status IN ('connected', 'disconnected', 'unknown')),
    last_connection_error  TEXT,
    sort_order  INTEGER,
    folder_id   TEXT REFERENCES connection_folders(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connections_driver
ON connections(driver);

CREATE INDEX IF NOT EXISTS idx_connections_environment
ON connections(environment);

CREATE INDEX IF NOT EXISTS idx_connections_folder_id
ON connections(folder_id, sort_order, created_at);
