# NexusPilot Cloud integration boundary

Status: **Current**

NexusPilot Cloud is an optional service. The desktop workbench remains usable for local connections, queries, data operations, and local AI features without signing in or enabling Cloud.

## Repository and service boundary

This public repository contains the desktop client and its versioned Cloud-facing contracts. The Cloud service implementation, operations console, deployment configuration, and production runbooks are maintained separately.

The desktop communicates with Cloud only through the public HTTPS API under `https://api.nexuspilot.dev/v1/`. It does not depend on Cloud implementation paths, database schemas, administrative APIs, or deployment topology.

## Authority

Cloud is authoritative for Cloud Account identity, subscription, entitlements, quotas, lifecycle timestamps, synchronization state, and registered-device status. Desktop caches may support offline display, but cannot authorize writes, device operations, recovery, or quota decisions.

## Encryption responsibility

The desktop generates and owns the Account Master Key, device keys, Recovery Key, and asset encryption. Cloud receives versioned public keys, opaque envelopes, nonces, ciphertext, and the metadata required to synchronize them. It must not receive plaintext connection credentials, the Account Master Key, a Recovery Key, or device private keys.

Device proof, envelope formats, and connection-asset associated data are frozen by [the Cloud V1 client contract](../contracts/cloud-v1-client-api.md). Product enablement and key handling follow [ADR 0003](../adr/0003-cloud-sync-cryptography-and-explicit-enablement.md).

## Explicit enablement

Signing in or reading Cloud state does not initialize sync. The user must explicitly start the encrypted-sync flow, name the device, generate and save a Recovery Key, and confirm enablement before the desktop registers the first device or uploads encrypted assets.

## Desktop storage

- Authentication and device private material use separate system credential-store namespaces.
- Recovery Keys are not stored by the application after one-time presentation; user-initiated native file saving is an explicit exception.
- The WebView receives only narrow, sanitized projections. Recovery Key presentation is limited to the one-time setup flow defined by ADR 0003.
- Local caches never include bearer tokens, identity claims, private keys, plaintext connection secrets, or Recovery Keys.

Connection-folder timestamps are exposed as UTC ISO 8601 strings. Local folder commands and Cloud folder application both write that text format. The original SQLite columns have INTEGER affinity and millisecond defaults, and older Cloud downloads wrote integer milliseconds. Folder repository reads normalize those legacy integer values to ISO strings while preserving existing text and stored rows. This compatibility is necessary for a subsequent sync reconciliation to read previously downloaded folders; no Cloud reset or local database deletion is required.

## Failure behavior

Conflict decisions preserve the authenticated connection-asset revision boundary. Keeping local decrypts the recorded local candidate with its original revision, then creates fresh ciphertext for `remoteRevision + 1`; it never reuses ciphertext after changing the CAS base. Keeping Cloud updates the local payload hash, base revision, tombstone/dependency state and retires superseded conflicted operations. Keeping both creates the new connection from the saved local candidate (merging only declared machine-local paths) before applying the Cloud candidate to the original connection.

An older KeepLocal implementation reused ciphertext with the wrong revision. During a writable sync, the originating device may repair that exact legacy result only when the downloaded asset, resolved conflict and successful/unknown upload record match the account, asset type, nonce, ciphertext, schema, key generation and revision relationship. It must authenticate the original candidate and verify its payload hash before staging a CAS write with freshly encrypted data. A deterministic repair operation ID preserves the staged request across retries. The cursor stays unchanged until the corrected page is fetched and passes normal validation; unmatched ciphertext and devices without the original records still fail closed. This does not change the V1 encryption format or allow arbitrary fallback revisions.

Cloud unavailability degrades Cloud status and synchronization without blocking the local workbench. Ambiguous write outcomes preserve operation IDs and local material for exact retry. Revoked devices, stale proofs, entitlement loss, cryptographic mismatch, and unknown protocol versions fail closed.

Validated asset pages are applied in a SQLite transaction together with their durable cursor. Within a page, active parent folders are applied before their child folders, followed by connections; connection tombstones precede folder tombstones. Cloud change order does not imply folder dependency order. Cyclic folder dependencies or parent folders absent from both the page and local storage reject the transaction without advancing the cursor.

Synchronization diagnostics identify bootstrap, sync-state, reconciliation, upload, pull-request, validation, and local-apply failures. JSON response diagnostics contain only the response type, HTTP status, body size where relevant, and parse category/coordinates. Local errors use allowlisted categories, including `missing_parent_folder` and timestamp column-decode failures. Logs do not include raw error bodies, connection values, account/device identifiers, tokens, or encryption material. The public `CLOUD_PROTOCOL_ERROR` remains a broad failure category and does not by itself prove that the server returned malformed JSON.
