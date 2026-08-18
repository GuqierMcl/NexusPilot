CREATE TABLE IF NOT EXISTS cloud_sync_assets (
    cloud_account_id       TEXT    NOT NULL,
    asset_id               TEXT    NOT NULL,
    asset_type             TEXT    NOT NULL CHECK (asset_type IN ('connection', 'connection_folder')),
    local_entity_id        TEXT    NOT NULL,
    remote_revision        INTEGER,
    base_revision          INTEGER,
    sync_status            TEXT    NOT NULL DEFAULT 'local_only'
                             CHECK (sync_status IN (
                                 'local_only',
                                 'pending_upload',
                                 'synced',
                                 'pending_delete',
                                 'conflicted',
                                 'needs_local_file',
                                 'remote_deleted'
                             )),
    last_error_code        TEXT,
    last_error_at          INTEGER,
    last_attempt_at        INTEGER,
    pending_operation_id   TEXT,
    tombstone              INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1)),
    conflict_of            TEXT,
    local_payload_hash     TEXT,
    created_at             INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at             INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (cloud_account_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_assets_account_status
ON cloud_sync_assets(cloud_account_id, sync_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_assets_local_entity
ON cloud_sync_assets(cloud_account_id, asset_type, local_entity_id);

CREATE TABLE IF NOT EXISTS cloud_sync_conflicts (
    id                      TEXT    PRIMARY KEY NOT NULL,
    cloud_account_id        TEXT    NOT NULL,
    asset_id                TEXT    NOT NULL,
    asset_type              TEXT    NOT NULL CHECK (asset_type IN ('connection', 'connection_folder')),
    base_revision           INTEGER,
    remote_revision         INTEGER NOT NULL,
    local_ciphertext        TEXT    NOT NULL,
    remote_ciphertext       TEXT    NOT NULL,
    local_nonce             TEXT    NOT NULL DEFAULT '',
    remote_nonce            TEXT    NOT NULL DEFAULT '',
    local_payload_hash      TEXT    NOT NULL,
    remote_payload_hash     TEXT    NOT NULL,
    local_action            TEXT    NOT NULL DEFAULT 'put'
                              CHECK (local_action IN ('put', 'delete')),
    local_revision          INTEGER,
    local_schema_version    INTEGER,
    local_key_generation    INTEGER,
    remote_schema_version   INTEGER NOT NULL DEFAULT 1,
    remote_key_generation   INTEGER NOT NULL DEFAULT 1,
    remote_tombstone        INTEGER NOT NULL DEFAULT 0 CHECK (remote_tombstone IN (0, 1)),
    pending_operation_id    TEXT,
    status                  TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'resolved')),
    detected_at             INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at              INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    UNIQUE (cloud_account_id, asset_id, remote_revision, status)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_conflicts_account_status
ON cloud_sync_conflicts(cloud_account_id, status, updated_at);

CREATE TABLE IF NOT EXISTS cloud_sync_operations (
    operation_id          TEXT    PRIMARY KEY NOT NULL,
    cloud_account_id      TEXT    NOT NULL,
    asset_id              TEXT    NOT NULL,
    asset_type            TEXT    NOT NULL CHECK (asset_type IN ('connection', 'connection_folder')),
    action                TEXT    NOT NULL CHECK (action IN ('put', 'delete')),
    expected_revision     INTEGER,
    schema_version        INTEGER,
    key_generation        INTEGER,
    nonce                 TEXT,
    ciphertext            TEXT,
    payload_hash          TEXT,
    status                TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'unknown', 'applied', 'conflicted', 'rejected')),
    attempt_count         INTEGER NOT NULL DEFAULT 0,
    last_error_code       TEXT,
    last_attempt_at       INTEGER,
    created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_operations_account_status
ON cloud_sync_operations(cloud_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_operations_asset
ON cloud_sync_operations(cloud_account_id, asset_id, created_at);

CREATE TABLE IF NOT EXISTS cloud_sync_cursors (
    cloud_account_id TEXT PRIMARY KEY NOT NULL,
    cursor           INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
