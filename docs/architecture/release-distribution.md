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
7. The same normalized platform artifacts are flattened into a GitHub Release asset set; colliding filenames receive deterministic platform prefixes.
8. A draft GitHub Release receives the artifacts and a matching checksum manifest, is verified by name, size, and GitHub-computed SHA-256 digest, and is published only when complete.

Updating mutable pointers last prevents clients from observing an incomplete release as current.

## GitHub Releases and object storage

GitHub Releases mirror each CI release for project discovery and source-hosting convenience. The canonical download and updater URLs remain the public `dl.nexuspilot.dev` boundary unless a separate decision changes that contract. Both destinations reuse the same normalized build artifacts; the GitHub mirror regenerates its checksum manifest only to account for the flat asset namespace and deterministic collision prefixes.

## Failure behavior

Public consumers show a clear unavailable state when release metadata cannot be loaded; they do not silently present bundled stale data as the latest release. Publishing retries must preserve immutable artifact paths and avoid moving the latest pointer until all required object-storage artifacts pass verification. GitHub Release retries may resume a draft or accept an already-published exact match, but must never overwrite a mismatched published release.

Operational commands, signing-key handling, and local release verification live in [the release guide](../development/release.md).
