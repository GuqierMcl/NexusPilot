# Architecture

Files in this directory describe the current implemented system and its maintained boundaries. They take precedence over roadmap and reference documents when those categories conflict.

| Document | Scope |
| --- | --- |
| [overview.md](./overview.md) | System map, process ownership, and primary boundaries. |
| [account-authentication.md](./account-authentication.md) | Optional account login, Deep Link, credential storage, and sanitized IPC. |
| [cloud-desktop-state.md](./cloud-desktop-state.md) | Desktop Cloud state projection and refresh behavior. |
| [cloud-integration.md](./cloud-integration.md) | Public desktop-to-Cloud boundary and zero-knowledge sync responsibilities. |
| [connection-runtime.md](./connection-runtime.md) | Driver registry, connection runtimes, capabilities, and execution. |
| [database-runtime-session.md](./database-runtime-session.md) | Shared and tab-scoped runtime session semantics. |
| [explorer-actions.md](./explorer-actions.md) | Explorer action registry and context-menu composition. |
| [explorer-tree.md](./explorer-tree.md) | Local and remote tree domains, containers, and lazy loading. |
| [frontend-data-flow.md](./frontend-data-flow.md) | Frontend stores, query state, IPC access, and invalidation. |
| [network-boundaries.md](./network-boundaries.md) | Rules for frontend, Rust, AI Runtime, provider, and Cloud requests. |
| [release-distribution.md](./release-distribution.md) | Release metadata, artifacts, updater, and public consumers. |
| [sites-and-documentation.md](./sites-and-documentation.md) | Product site, documentation site, and knowledge-source separation. |
