# NexusPilot public knowledge base

`docs/` is the authoritative public knowledge base for users, contributors, maintainers, and coding agents. Publication on `docs.nexuspilot.dev` is a separate concern: only the rewritten content under `guides/` is loaded by the documentation site.

## Reading paths

- Product users: start with the [documentation site](https://docs.nexuspilot.dev) or the source in [guides](./guides/).
- New contributors: read [AGENTS.md](../AGENTS.md), [architecture/overview.md](./architecture/overview.md), and [development](./development/README.md).
- Driver contributors: continue with [connection-runtime.md](./architecture/connection-runtime.md), [database-runtime-session.md](./architecture/database-runtime-session.md), the [Engine IPC contract](./contracts/ipc/engine.md), and [add-new-database-driver.md](./development/add-new-database-driver.md).
- AI Runtime contributors: start at [ai-runtime/README.md](./ai-runtime/README.md) and follow its domain-specific map.
- Security and protocol review: read [contracts](./contracts/README.md) and [architecture decisions](./adr/README.md).

## Information architecture

| Directory | Primary audience | Authority |
| --- | --- | --- |
| [`guides/`](./guides/) | Users and developers | Rewritten public guides rendered at `docs.nexuspilot.dev`. |
| [`architecture/`](./architecture/) | Contributors and maintainers | Current implemented system and process boundaries. |
| [`contracts/`](./contracts/) | Implementers and reviewers | Stable or frozen IPC, service, data, and cryptographic boundaries. |
| [`ai-runtime/`](./ai-runtime/) | AI Runtime contributors | Current Runtime domain, execution, tools, providers, and lifecycle. |
| [`development/`](./development/) | Contributors | Implementation, testing, extension, UI, and release guidance. |
| [`product/`](./product/) | Product and engineering contributors | Product intent and detailed current capability boundaries. |
| [`adr/`](./adr/) | Maintainers and reviewers | Accepted architectural choices and their consequences. |
| [`roadmap/`](./roadmap/) | Contributors | Work not yet fully implemented; never overrides current facts. |
| [`reference/`](./reference/) | Researchers and maintainers | Useful non-authoritative or aspirational context. |

## Status language

- **Current**: describes maintained implementation behavior.
- **Frozen**: compatibility-sensitive contract; breaking changes require explicit versioning or a replacement decision.
- **Accepted**: architectural decision that governs current and future changes until superseded.
- **Aspirational**: possible future direction, not an implementation promise.
- **Archived**: retained historical context that must not be treated as current behavior.

When documents conflict, a Frozen contract wins within its declared scope, then Current architecture or domain documentation, then Accepted ADRs as design rationale. Roadmap and reference documents never authorize behavior that current code and capabilities do not implement. Resolve genuine disagreement by checking code and executable tests, failing closed where security or mutation is involved, and updating the authoritative document in the same change.

## Documentation-site boundary

The renderer in [`sites/docs/`](../sites/docs/) loads only `docs/guides/**/*.{md,mdx}` through an allowlist. Do not place a second copy of ordinary documentation under the site package, and do not expand the loader to scan all of `docs/`.

## What must not be committed

Do not add personal AI plans, prompts, transcripts, worklogs, scratch notes, private design diaries, credentials, local connection details, unredacted production data, or machine-specific paths. The historical `docs/superpowers/` path is explicitly excluded. Reusable engineering decisions should be rewritten into the appropriate public architecture, contract, ADR, product, development, or roadmap document without copying the private collaboration record.

Cloud service implementation, operations-console, deployment, and production-runbook details belong to the separate private NexusPilot-Cloud repository. This repository documents only the public Desktop-facing Cloud boundary and client contract.
