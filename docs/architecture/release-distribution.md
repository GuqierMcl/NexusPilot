# Release distribution architecture

Status: **Current**

NexusPilot release artifacts and metadata serve four independent consumers: direct downloads, the Tauri updater, the product website, and the documentation release index.

## Public data boundary

Release metadata is generated during the release workflow and published under `https://dl.nexuspilot.dev/releases`. New metadata and artifacts use only `nexuspilot.dev` domains.

The published data includes immutable version directories plus small mutable indexes for the latest release and release history. Website and documentation builds consume that public boundary; they do not read the root package version, Tauri configuration, release scripts, or private build state.

## Artifact flow

1. Platform jobs build and sign native artifacts for their target.
2. Checksums and normalized artifact metadata are produced.
3. A final publishing job verifies the complete expected platform set.
4. Immutable `releases/vX.Y.Z/**` content is uploaded first.
5. The release history index is updated.
6. The latest-release pointer and Tauri updater manifest are updated last.

Updating mutable pointers last prevents clients from observing an incomplete release as current.

## GitHub Releases and object storage

GitHub Releases may mirror future release artifacts for project discovery and source-hosting convenience. The canonical download and updater URLs remain the public `dl.nexuspilot.dev` boundary unless a separate decision changes that contract. Uploading to both destinations must reuse the same verified artifacts and checksums rather than rebuilding them independently.

## Failure behavior

Public consumers show a clear unavailable state when release metadata cannot be loaded; they do not silently present bundled stale data as the latest release. Publishing retries must preserve immutable artifact paths and avoid moving the latest pointer until all required artifacts pass verification.

Operational commands, signing-key handling, and local release verification live in [the release guide](../development/release.md).
