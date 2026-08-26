# ADR 0002: Use Bun for JavaScript and TypeScript workspaces

## Status

Accepted

## Context

NexusPilot contains the React frontend, the local AI Runtime, and two Astro sites. Using different JavaScript package managers across those workspaces would create multiple lockfiles, inconsistent dependency resolution, and unnecessary contributor setup.

## Decision

Bun is the required package manager and JavaScript runtime for repository JavaScript and TypeScript workspaces.

- `bun.lock` is the only JavaScript dependency lockfile.
- Repository scripts and documentation use `bun install`, `bun run`, `bun test`, and `bunx`.
- npm, pnpm, Yarn, and their lockfiles are not used for project dependency management.
- Rust remains managed by Cargo.
- Release and packaging scripts may invoke platform tools, but they must not introduce another JavaScript package manager.

## Consequences

- Contributors install one JavaScript toolchain.
- CI, local development, the AI Runtime, and both sites resolve the same lockfile.
- Dependency updates must be performed with Bun and include the resulting lockfile change.
- Packages that depend on Node-specific behavior require explicit compatibility testing under Bun.

## References

- [Contributor development guides](../development/README.md)
- [Release guide](../development/release.md)
