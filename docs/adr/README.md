# Architecture Decision Records

Architecture Decision Records explain accepted choices, their context, and their consequences. They do not replace current implementation documentation: when an accepted decision changes runtime behavior, update the corresponding files under `architecture/`, `contracts/`, `ai-runtime/`, or `development/` in the same change.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](./0001-ai-runtime-stack.md) | Accepted | Use Bun, Elysia, and the AI SDK for the local AI Runtime. |
| [0002](./0002-main-package-manager-bun.md) | Accepted | Use Bun for JavaScript and TypeScript workspaces. |
| [0003](./0003-cloud-sync-cryptography-and-explicit-enablement.md) | Accepted | Use versioned E2EE envelopes and an explicit Cloud enablement flow. |

Create a new ADR for a materially different decision. Do not rewrite an old ADR to pretend the superseded choice never existed; mark it superseded and link to the replacement.
