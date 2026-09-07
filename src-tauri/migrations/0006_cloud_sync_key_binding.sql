-- Cursors, baselines and pending ciphertext belong to one account master key.
CREATE TABLE cloud_sync_key_bindings (
    cloud_account_id TEXT PRIMARY KEY NOT NULL,
    key_fingerprint TEXT NOT NULL
);

-- Only encrypted projections are staged across pages.
CREATE TABLE cloud_sync_pull_staging (
    cloud_account_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    asset_type TEXT NOT NULL,
    tombstone INTEGER NOT NULL,
    parent_id TEXT,
    change_json TEXT NOT NULL,
    PRIMARY KEY (cloud_account_id, asset_id)
);

CREATE TABLE cloud_sync_pull_batches (
    cloud_account_id TEXT PRIMARY KEY NOT NULL,
    requested_cursor INTEGER NOT NULL,
    next_cursor INTEGER NOT NULL
);
