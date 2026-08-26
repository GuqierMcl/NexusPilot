# Auth and Cloud IPC

Status: **Current**

This document highlights the desktop IPC security boundary for optional account and Cloud features. The complete consolidated IPC contract remains available in [overview.md](./overview.md).

## Auth IPC

- Authentication protocol handling, token exchange, refresh, logout, and Keychain access remain in Rust.
- The WebView receives a sanitized account projection, never bearer tokens, refresh tokens, authorization codes, raw claims, issuer/subject identity keys, or credential-store entries.
- Deep Link callbacks are parsed and validated by Rust. Authentication URLs are not forwarded through a general frontend event channel.
- Account avatars are normalized and cached through the trusted native boundary; arbitrary remote avatar URLs are not handed directly to UI components.
- Local logout clears runtime authentication state without requiring provider network access. Destructive provider-session actions are separate and explicit.

## Cloud IPC

- Cloud access tokens are obtained through the Rust authentication broker and never accepted from frontend command arguments.
- Cloud commands return sanitized account, entitlement, lifecycle, device, synchronization, and error projections.
- Desktop display caches are labeled with their source and timestamp. They cannot authorize synchronization, device, recovery, deletion, or quota-sensitive operations.
- Device proof signing, private keys, Account Master Keys, Recovery Keys, encrypted-asset plaintext, and proof nonces remain in Rust/native storage.
- The one-time Recovery Key setup response is the only narrow WebView exception and follows [ADR 0003](../../adr/0003-cloud-sync-cryptography-and-explicit-enablement.md).

## Failure rules

Authentication or Cloud unavailability must not block the local database workbench. Invalid sessions, device revocation, stale proofs, unknown protocol versions, cryptographic failures, and entitlement denial fail closed. Errors are structured and sanitized before crossing IPC.
