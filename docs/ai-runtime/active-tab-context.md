# Active tab context

Status: **Current**

Ordinary user messages may carry one metadata snapshot of the selected workbench tab. SQL editor messages may also carry a bounded content snapshot captured synchronously at form submission, before assistant-ui awaits attachment uploads. A later tab switch cannot change that submission. Result rows, designer drafts, callbacks and credentials are never read or serialized.

## Contract and registration

`contracts/ai-runtime/active-tab-context.ts` owns the version 1 schema and UI part codec; Runtime model projection lives in `ai-runtime/src/runtime/context/active-tab-projection.ts`. `POST /v1/runs` accepts optional `activeTabContext` separately from `input.parts`. It contains `tabId`, `type`, `title`, `dirty`, `revision`, optional `connection` (`id`, `driver`, `database`, `schema`), and `capabilities` (`metadata: true`, `content: false`, `actions: []`). Labels are limited to 256 characters, revision to 80, and serialized UTF-8 metadata to 4096 bytes. Unknown fields, versions, types and capabilities are rejected before Run creation with `INVALID_RUN_INPUT`; internal runner callers pass the same validation. Omission remains compatible with older messages and clients.

`active-tab-registry.ts` is a pure data registry, separate from tab rendering. Each registration declares a metadata descriptor and may register a content capture provider. SQL tabs use their current execution context and capture either the non-empty editor selection or the full editor document when no selection exists; table and designer tabs use their container context; key-value tabs identify their selected database. Unknown or unregistered types produce no automatic snapshot. Descriptors project an explicit allowlist and never serialize the tab payload or runtime store. New tab types extend the shared type allowlist and registry without changing generic capture, submission or history algorithms. Content providers require an explicit contract extension; capability metadata does not authorize tools or bypass Agent policy, risk analysis or approval.

`revision` is a deterministic fingerprint of the projected **metadata**, not a content version. SQL content has its own `content-v1-*` revision and preserves the exact UTF-16 selection range when a selection is sent. Historical chips compare the saved metadata revision with current metadata solely for a subtle tooltip; the snapshots themselves are immutable.

## Drafts and presentation

New drafts follow the active tab. Removing the chip changes only that draft to omission, including across tab switches. Sending or clearing all text and attachments restores following for the next draft. Editing a historical message and recovering a rejected submission restore its original snapshot or explicit absence. Composer state keeps the submitted snapshot distinct from the next draft while attachment uploads finish.

AI SDK UI messages append `data-active-tab-context` and, for SQL content, `data-sql-editor-content` parts; assistant-ui renders their native `{ type: "data", name, data }` equivalents through `MessagePrimitive.Parts`. Both Thread variants use the same renderer. The marker is an icon and truncated title at the user message tail, with no navigation or details card. Its description distinguishes attached SQL content from metadata-only or oversized content. Native message copy only copies text. Existing reference/command highlights remain attached to the text part. `/help` and `/compact` do not submit this metadata or content as a user message; `/explain` follows ordinary submission.

## Persistence and model context

The runner saves `UserMessage.activeTabContext` and optional `UserMessage.activeTabContent` in the existing message JSON transaction. No storage migration or frontend history database is needed. SQLite reload, both UI projections, append-only history editing and failed-draft recovery preserve the submitted facts. An edit may explicitly remove either one; earlier audit branches remain unchanged.

Model projection adds separate user-level text blocks after the message parts. Runtime-owned framing identifies metadata and SQL as untrusted historical user data, states that SQL was not executed, and grants no tab actions. SQL is never truncated silently; an oversized capture sends metadata only and shows a lightweight composer warning. These blocks never become system instructions or user-visible body text. Cross-model history uses the same projection. Token estimation and canonical compaction sources include them; original audit snapshots remain intact after compaction. Old canonical sources without these fields retain their serialization.

## Verification

`tests/active-tab-context.test.ts` and `tests/sql-editor-content-context.test.ts` cover registry boundaries, strict schema validation, selection precedence and transport/edit semantics. `ai-runtime/tests/active-tab-context.test.ts` exercises HTTP rejection, real SQLite reload, both UI projections, model/summary projection and token accounting. `tests/browser/composer/active-tab-check.cjs` covers current-tab selection among 100 tabs, SQL content transport, omission/reset, native copy, metadata changes, history editing, virtualized rendering, failed-draft recovery, attachment upload freezing and existing reference/command behavior. It runs against the existing composer browser fixture, alongside `check.cjs`.
