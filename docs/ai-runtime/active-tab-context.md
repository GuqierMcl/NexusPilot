# Active tab context

Status: **Current**

Ordinary user messages may carry one metadata snapshot of the selected workbench tab. The frontend captures it synchronously at form submission, before assistant-ui awaits attachment uploads. A later tab switch cannot change that submission. No tab body, SQL text, result rows, designer draft, callbacks or credentials are read or serialized.

## Contract and registration

`shared/active-tab-context.ts` owns the version 1 schema, UI part codec and model projection. `POST /v1/runs` accepts optional `activeTabContext` separately from `input.parts`. It contains `tabId`, `type`, `title`, `dirty`, `revision`, optional `connection` (`id`, `driver`, `database`, `schema`), and `capabilities` (`metadata: true`, `content: false`, `actions: []`). Labels are limited to 256 characters, revision to 80, and serialized UTF-8 metadata to 4096 bytes. Unknown fields, versions, types and capabilities are rejected before Run creation with `INVALID_RUN_INPUT`; internal runner callers pass the same validation. Omission remains compatible with older messages and clients.

`active-tab-registry.ts` is a pure data registry, separate from tab rendering. Each registration declares a metadata descriptor and capabilities. SQL tabs use their current execution context; table and designer tabs use their container context; key-value tabs identify their selected database. Unknown or unregistered types produce no automatic snapshot. Descriptors project an explicit allowlist and never serialize the tab payload or runtime store. New tab types extend the shared type allowlist and registry without changing generic capture, submission or history algorithms. Future content providers require an explicit contract extension; capability metadata does not authorize tools or bypass Agent policy, risk analysis or approval.

`revision` is a deterministic fingerprint of the projected **metadata**, not a content version. Changing SQL text without changing metadata does not claim a new content revision. Historical chips compare the saved revision with current metadata solely for a subtle tooltip; the snapshot itself is immutable.

## Drafts and presentation

New drafts follow the active tab. Removing the chip changes only that draft to omission, including across tab switches. Sending or clearing all text and attachments restores following for the next draft. Editing a historical message and recovering a rejected submission restore its original snapshot or explicit absence. Composer state keeps the submitted snapshot distinct from the next draft while attachment uploads finish.

AI SDK UI messages append a `data-active-tab-context` part; assistant-ui renders its native `{ type: "data", name: "active-tab-context", data }` equivalent through `MessagePrimitive.Parts`. Both Thread variants use the same renderer. The marker is an icon and truncated title at the user message tail, with no navigation or details card. Native message copy only copies text. Existing reference/command highlights remain attached to the text part. `/help` and `/compact` do not submit this metadata as a user message; `/explain` follows ordinary submission.

## Persistence and model context

The runner saves `UserMessage.activeTabContext` in the existing message JSON transaction. No storage migration or frontend history database is needed. SQLite reload, both UI projections, append-only history editing and failed-draft recovery preserve the submitted fact. An edit may explicitly remove it; earlier audit branches remain unchanged.

Model projection adds a separate user-level text block after the message parts. Runtime-owned framing identifies its JSON as untrusted historical metadata, states that tab content is absent, and grants no tab actions. It never becomes a system instruction or user-visible body text. Cross-model history uses the same projection. Token estimation and canonical compaction sources include this block; original audit snapshots remain intact after compaction. Old canonical sources without a tab field retain their serialization.

## Verification

`tests/active-tab-context.test.ts` covers registry boundaries, strict schema validation and transport/edit semantics. `ai-runtime/tests/active-tab-context.test.ts` exercises HTTP rejection, real SQLite reload, both UI projections, model/summary projection and token accounting. `tests/browser/composer/active-tab-check.cjs` covers current-tab selection among 100 tabs, omission/reset, native copy, metadata changes, history editing, virtualized rendering, failed-draft recovery, attachment upload freezing and existing reference/command behavior. It runs against the existing composer browser fixture, alongside `check.cjs`.
