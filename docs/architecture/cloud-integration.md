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

## Failure behavior

Cloud unavailability degrades Cloud status and synchronization without blocking the local workbench. Ambiguous write outcomes preserve operation IDs and local material for exact retry. Revoked devices, stale proofs, entitlement loss, cryptographic mismatch, and unknown protocol versions fail closed.
