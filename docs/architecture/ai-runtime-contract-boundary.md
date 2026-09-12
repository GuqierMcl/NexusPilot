# AI Runtime contract source boundary

Status: **Current**

## Decision summary

NexusPilot keeps a single repository and a single product version. The
frontend and the local AI Runtime continue to be separate execution
boundaries, but they share cross-process TypeScript contracts from one
explicit source directory:

```text
contracts/ai-runtime/
```

The repository does not add a new `packages/*` workspace or an independently
published contract package. `contracts/ai-runtime` is an internal source
boundary. It contains protocol definitions and pure validation/serialization
helpers; frontend capture and UI behavior stay in `src/`, and model projection
and Runtime policy stay in `ai-runtime/`.

## Problem

The current root `shared/` directory is not a package, is not included in the
AI Runtime TypeScript project, and is reached through deep relative imports
from both applications. It therefore has no explicit owner or dependency
direction. Bun correctly warns that the imported files are outside the AI
Runtime project directory and will not be watched reliably.

The directory also mixes three kinds of behavior:

- wire contracts for active-tab, SQL-editor, composer-reference, and
  composer-command data;
- frontend capture, draft, and reference-composition behavior;
- AI Runtime model-history and prompt projection behavior.

Adding the directory to a TypeScript `include` list would address compilation
only. It would leave the ownership and watch boundaries implicit.

## Goals

- Keep the repository as a single product repository without adding a new
  workspace package or package-publishing workflow.
- Give frontend and AI Runtime protocol code one explicit, stable source
  directory.
- Remove deep relative imports that cross the current application boundaries.
- Keep Zod runtime schemas, OpenAPI generation, protocol parsing, and size
  limits as executable sources of truth.
- Make development watch boundaries explicit and narrow:
  - AI Runtime watches `ai-runtime/**` and `contracts/ai-runtime/**` only.
  - Vite watches frontend source/configuration and
    `contracts/ai-runtime/**`; it ignores backend, Runtime, sites, docs, and
    generated directories.
- Keep current composer and SQL editor behavior unchanged while moving files.
- Leave room for later protocol versions and new registered reference types.

## Non-goals

- Turning the repository into a conventional monorepo with independently
  released packages.
- Publishing the contract source to npm or maintaining a separate package
  version.
- Moving React, Tauri, database, or Runtime implementation code into the
  contract directory.
- Changing the HTTP protocol or the persisted message shape as part of the
  boundary migration.
- Introducing a code-generation pipeline before the current source boundary
  has been made explicit.

## Target source layout

```text
contracts/
└── ai-runtime/
    ├── active-tab-context.ts
    ├── composer-commands.ts
    ├── composer-references.ts
    ├── sql-editor-content-context.ts
    └── index.ts

src/
└── features/workbench/agent/
    ├── composer/          # capture, draft, UI registries, rendering
    └── runtime/           # frontend HTTP/message adapters

ai-runtime/src/
├── routes/                # HTTP/OpenAPI composition
├── runtime/               # storage, runners, model projection, policy
└── ...
```

The first migration preserves the four existing modules and their behavior.
The follow-up cleanup moves side-specific functions out of the contract layer:

| Concern | Owner after cleanup |
| --- | --- |
| Zod schemas, public types, part names, limits | `contracts/ai-runtime` |
| Protocol parsing and structural validation | `contracts/ai-runtime` |
| OpenAPI schema descriptions | `contracts/ai-runtime` |
| SQL/editor capture and selection state | Frontend composer/editor code |
| Composer draft and UI reference composition | Frontend composer code |
| Model prompt/history projection | `ai-runtime/src/runtime` |
| Runtime command prompt resolution | `ai-runtime/src/runtime` |
| Runtime-specific reference descriptions | `ai-runtime/src/runtime` |

The protocol-level reference registry remains extensible. UI renderers and
Runtime descriptions consume the stable reference identity and payload
contract through their own adapters, so adding a new reference type does not
require adding React or database behavior to the contract directory.

## Import boundary

The root TypeScript configuration and Vite alias expose the contract source as
an internal alias. The AI Runtime TypeScript configuration exposes the same
alias to its own source and tests. All consumers use the alias or the
contract index; no consumer reaches into the directory through a relative
path.

The migration must remove every import of the form:

```text
../shared/...
../../shared/...
../../../shared/...
../../../../shared/...
```

The contract source must not import from `src/`, `ai-runtime/`, Rust files,
React, Tauri, or site packages. Its only runtime dependency remains the
repository's selected Zod version. Root and Runtime Zod versions will be
aligned as part of the migration so the schema boundary has one predictable
runtime dependency.

## Development watch boundaries

### AI Runtime

The root `ai-runtime:dev` command is the canonical development entry point.
It starts the Runtime from the repository root so Bun's project boundary
contains exactly the Runtime and contract source trees needed by the process:

```text
ai-runtime/**
contracts/ai-runtime/**
```

The Runtime entry graph must contain only Runtime and contract modules. The
watcher must ignore frontend, Rust, sites, documentation, scripts, generated
output, and repository metadata. Changes under those trees must not restart
the AI Runtime. Because Bun watches imported modules rather than an explicit
directory allowlist, this requirement is enforced by keeping excluded trees
out of the Runtime import graph and by testing edits in excluded trees.

The existing `ai-runtime` package-local command remains useful for package
tests and typechecking, but the root command is the supported hot-reload path.
The implementation will verify that a contract edit restarts the Runtime and
that an edit in an excluded tree does not.

### Vite

Vite continues to serve the frontend from the repository root. Its watch
allowlist is the frontend source, static assets, frontend configuration, and
the contract source:

```text
src/**
contracts/ai-runtime/**
public/**
index.html
vite.config.ts
tsconfig*.json
```

Vite's chokidar `ignored` predicate must ignore every other repository path,
including at least:

```text
ai-runtime/**
src-tauri/**
sites/**
docs/**
scripts/**
dist/**
node_modules/**
.git/**
.github/**
.vscode/**
```

The current broad frontend behavior is retained for files needed by the
frontend build, while backend and sidecar trees are explicitly excluded. Root
dependency metadata may require a manual Vite restart and is outside the HMR
allowlist. The implementation will verify that frontend and contract edits
trigger HMR and that Runtime/Rust edits do not.

## Migration sequence

1. Create `contracts/ai-runtime` and move the four contract modules without
   changing their public behavior.
2. Add the shared alias to root TypeScript/Vite configuration and the AI
   Runtime TypeScript configuration.
3. Update frontend, Runtime, and test imports to use the contract alias.
4. Move frontend-only capture/composer helpers and Runtime-only projection
   helpers to their owning trees where doing so does not change the wire
   contract.
5. Align the Zod dependency versions used by the root app, Runtime, and
   contract source.
6. Replace the root Runtime development command and narrow Vite's watch
   ignores/entries to the boundaries above.
7. Update architecture and AI Runtime documentation to reference the new
   source boundary instead of `shared/`.
8. Delete `shared/` only after repository-wide import and type checks confirm
   that no source or test still depends on it.

## Verification

The migration is complete only when all of the following hold:

- `rg` finds no imports from the deleted `shared/` directory.
- `bun run tsc --noEmit` passes.
- `bun run ai-runtime:typecheck` passes.
- The focused contract/composer tests pass.
- The complete AI Runtime test suite passes.
- `bun run build` passes.
- `bun run ai-runtime:build` passes.
- Starting `bun ai-runtime:dev` produces no project-directory watch warning.
- Editing a contract file restarts Runtime and updates frontend HMR.
- Editing a Rust, Runtime-excluded, documentation, or site file does not
  restart the frontend or Runtime watcher.
- `git diff --check` passes.
