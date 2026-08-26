# NexusPilot Cloud V1 client API

Status: **Frozen**

This contract defines the public Desktop-facing API under `https://api.nexuspilot.dev/v1/`. It intentionally excludes Cloud implementation paths, database schemas, operations-console endpoints, deployment configuration, and service runbooks.

Compatible V1 changes may add optional fields, optional response objects, or new endpoints whose absence old clients can handle. Existing field types, requiredness, enum meanings, error semantics, authorization boundaries, state transitions, and cryptographic byte formats must not change silently.

## Authentication and device proof

- User APIs use a NIEEX Account bearer token. Cloud validates issuer, audience, signature, expiry, and the `cloud:access` scope.
- The account is internally keyed by issuer and subject; those identity keys are not echoed to the Desktop.
- Device-scoped APIs additionally use `x-nexuspilot-device-id`, `x-nexuspilot-device-timestamp`, `x-nexuspilot-device-nonce`, and `x-nexuspilot-device-signature`.
- Device Proof V1 signs a domain-separated, length-prefixed message containing `NexusPilot.Cloud.DeviceProof.v1`, `METHOD + path`, Cloud Account ID, Device ID, canonical UTC timestamp, the Base64url 16-byte nonce, and the Base64url SHA-256 of canonical JSON payload.
- Each field is UTF-8 prefixed by a 4-byte unsigned big-endian byte length.
- Canonical JSON recursively sorts object keys by Unicode order, preserves arrays, and rejects undefined, non-JSON, and non-finite numeric values.
- Timestamps use `toISOString()` form and are accepted only within the server clock-skew window. A nonce is consumed transactionally; replay returns `409 device_proof_replayed`.

## Lifecycle and idempotency

| State | Meaning |
| --- | --- |
| `active` | Current entitlements permit the requested read, write, device, or recovery operation. |
| `read_only_grace` | Existing ciphertext and Recovery Envelope may be read when entitled; new writes and continuing-device registration are denied. |
| `retained` | Data is retained while ordinary synchronization and recovery writes are paused. |
| `deletion_pending` | Ordinary synchronization is disabled while lifecycle deletion may proceed. |
| `deleted` | Lifecycle deletion completed; necessary account, billing, audit, and backup records may follow separate retention rules. |

Every write carries a stable UUID `operationId`. The same account, operation ID, and request fingerprint returns the original result with `replayed=true`. Reusing the ID for a different payload, device, resource, or action fails closed. When a client cannot determine the result, it retries the exact request and does not create a new operation ID.

## Endpoint summary

| Endpoint | Protection | Contract |
| --- | --- | --- |
| `POST /v1/account/bootstrap` | Bearer | Idempotently creates or reads the Cloud Account and returns the authoritative subscription and entitlement projection. |
| `GET /v1/account/entitlements` | Bearer | Returns feature permissions, quota usage, subscription, and lifecycle timestamps. |
| `GET /v1/sync/state` | Bearer | Returns initialization, key generation, and active-device summary. |
| `POST /v1/sync/initialize` | Bearer + first-device request | Atomically registers the first device and opaque device/recovery envelopes. |
| `/v1/sync/device-authorizations` | Bearer + device proof where applicable | Creates, polls, approves, denies, cancels, and claims one-time device authorization envelopes. |
| `GET /v1/sync/devices` | Bearer + active device proof | Returns the sanitized registered-device projection. |
| `POST /v1/sync/devices/:deviceId/revoke` | Bearer + active device proof | Permanently revokes a device, including the last active device. |
| `/v1/sync/connection-assets` | Bearer + active device proof | Cursor reads, CAS revision writes, and Tombstone deletes for encrypted assets. |
| `GET /v1/sync/recovery-envelope` | Bearer | Reads the current opaque Recovery Envelope in lifecycle states that allow recovery. |
| `POST /v1/sync/recovery-devices` | Bearer + Recovery Auth signature | Registers a replacement device without an existing device after local envelope recovery. |
| `PUT /v1/sync/recovery-envelope` | Bearer + active device proof | Atomically rotates the envelope using expected revision and operation ID. |
| `DELETE /v1/sync/data` | Bearer + active device proof | With `confirmation=DELETE_CLOUD_SYNC_DATA`, clears the current sync domain while retaining account, entitlement, lifecycle, and necessary security audit facts. |

## Desktop projection and caching

A normal refresh obtains account bootstrap, entitlements, and sync state, and reads devices only when committed device material exists. These responses form one sanitized Desktop projection.

The Desktop may persist the last complete successful projection for offline display. It must include `source=cache` and `cachedAt`, and cannot contain tokens, issuer/subject, raw claims, account master keys, Recovery Keys, device private keys, Device Proof material, ciphertext, or connection plaintext. Cached state never authorizes device actions, asset operations, recovery, envelope rotation, data deletion, or quota decisions.

## Cryptographic formats

### Device envelope

- Suite: `HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305`.
- HPKE info: UTF-8 `NexusPilot/Cloud/device-envelope/v1`.
- AAD is compact JSON in fixed field order: `purpose`, `formatVersion`, `cloudAccountId`, `deviceId`, `keyGeneration`, `encryptionPublicKeySha256`.
- Purpose is `nexuspilot-cloud-amk-envelope`.
- `encapsulatedKey` is 32 bytes; ciphertext is a 32-byte AMK plus a 16-byte tag. Binary values use unpadded Base64url.

### Recovery Envelope

- Suite: `XCHACHA20POLY1305-HKDF-SHA256`; salt 32 bytes, nonce 24 bytes, ciphertext 48 bytes.
- The Recovery Key is a 32-byte secret encoded as Bech32m with HRP `nprk`.
- KEK uses HKDF-SHA-256 with the envelope salt and info `NexusPilot/Cloud/recovery-envelope-key/v1`.
- AAD uses fixed compact-JSON fields `purpose`, `formatVersion`, `cloudAccountId`, and `keyGeneration`; purpose is `nexuspilot-cloud-amk-recovery-envelope`.
- Recovery registration proves possession through an Ed25519 public key derived from the Recovery Key. Cloud never receives the Recovery Key or AMK.

### Connection assets

- Suite: `XCHACHA20-POLY1305`; nonce 24 bytes; ciphertext contains at least the 16-byte tag.
- AAD is a 4-byte big-endian length-prefixed concatenation of `NexusPilot.ConnectionAsset.v1`, Cloud Account ID, asset ID, asset type, target revision, schema version, key generation, and suite.
- Creates use revision `1`; updates use `expectedRevision + 1`; deletes are ciphertext-free Tombstones.
- Cloud stores the values as opaque data and does not decrypt or decode AAD.

## Compatibility

- Existing optional fields cannot become required, and existing enum values cannot change meaning.
- Unknown errors are handled through HTTP status and stable retry/error categories, never as success.
- Breaking state, suite, or field changes require `/v2`, a new `formatVersion`, or a new suite identifier.
- Operation IDs remain account-scoped and stable for destructive, device, recovery-envelope, and asset operations.

See [Cloud integration boundary](../architecture/cloud-integration.md) and [ADR 0003](../adr/0003-cloud-sync-cryptography-and-explicit-enablement.md).
