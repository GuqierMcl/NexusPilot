# Contributing to NexusPilot

Thank you for your interest in NexusPilot. Contributions are welcome for the desktop database workbench, AI Runtime, database integrations, documentation, and user-facing website.

NexusPilot is prepared from a private source repository into a separate public repository. The public repository contains the open-source desktop client, product website, and documentation site; private Cloud server code and internal design records are maintained separately.

## Before you start

Please read:

- [README.md](./README.md) for the product scope, supported databases, and Cloud behavior.
- [AGENTS.md](./AGENTS.md) for the current architecture overview, code style, build commands, and AI-assisted development conventions.
- [SECURITY.md](./SECURITY.md) before reporting a potential security vulnerability.

Please search existing Issues and Pull Requests before opening a new one. For security vulnerabilities, do not use a public Issue; follow [SECURITY.md](./SECURITY.md) instead.

## Development requirements

- Bun `1.3.12` or a compatible Bun release
- Rust stable toolchain
- Tauri v2 build prerequisites for your operating system

Install JavaScript dependencies with Bun:

```bash
bun install
```

Do not use npm, pnpm, or yarn for this repository.

## Local verification

Run the checks relevant to your change before opening a Pull Request:

```bash
# Frontend type-check
bun run tsc --noEmit

# AI Runtime
bun run ai-runtime:typecheck
bun run ai-runtime:test

# Rust backend
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# Frontend production build when changing the application or build configuration
bun run build
```

When changing a public site, install its dependencies and run its documented build command from `sites/product/` or `sites/docs/`. Documentation source belongs in `docs/guides/`, while rendering and deployment code belongs in `sites/docs/`. When a change affects shared navigation or public links, verify both sites with `bun run sites:build` from the repository root.

If a check cannot be run locally, explain why in the Pull Request and include the checks that were run instead.

## Making changes

- Keep changes focused and explain the user-visible result.
- Use the `@/` alias for internal frontend imports.
- Keep TypeScript and Rust IPC types synchronized.
- Use `apiInvoke()` for engine commands and preserve structured error handling.
- When changing behavior, contracts, or architecture, update the corresponding public documentation when applicable.
- Do not add credentials, private connection strings, production tokens, signing keys, or sensitive business data to source files, tests, Issues, or Pull Requests.
- Do not add private Cloud server code or internal design records to the public repository.

## Commit messages

Use Conventional Commit types with a concise Chinese summary, following the repository convention in `AGENTS.md`:

```text
feat(scope): 添加清晰的功能摘要

- 说明主要实现变化。
- 说明测试或文档同步情况。
```

Common types include `feat`, `fix`, `docs`, `test`, `refactor`, and `chore`.

## Pull Requests

Please include:

- What changed and why.
- The affected area: frontend, Rust backend, AI Runtime, product site, documentation site, or shared contracts.
- Tests and verification commands that were run.
- Screenshots or recordings for meaningful UI changes.
- Any follow-up work or known limitations.

Keep unrelated formatting changes out of the Pull Request. Maintainers may ask for documentation or contract updates when a change affects user-visible behavior or cross-module interfaces.

By contributing, you agree that your contribution is provided under the repository's [Apache-2.0 license](./LICENSE).

## Questions

For general questions, use a GitHub Discussion or Issue when the public repository makes those channels available. For private or security-sensitive matters, contact [support@nexuspilot.dev](mailto:support@nexuspilot.dev).
