# Composer references and commands

The workbench composer supports explicit connection references, local `/help`, persisted `/explain`, and the `/compact` conversation operation. References and message commands are user input, not authorization or verified database state. Selecting a candidate reads the saved local directory only. Database access continues through the existing mode, tool, Rust capability, and permission boundaries.

## Public request and durable facts

`POST /v1/runs` accepts an optional `references` field on each text input part. Existing plain text and file inputs remain valid. The shared schema and limits are defined in `shared/composer-references.ts`.

```json
{
  "type": "text",
  "text": "查看 @开发库",
  "references": {
    "version": 1,
    "targets": [{
      "sourceId": "connections",
      "type": "connection",
      "version": 1,
      "id": "profile-123",
      "label": "开发库",
      "data": { "driver": "postgresql" }
    }],
    "occurrences": [{
      "id": "occurrence-123",
      "label": "开发库",
      "start": 3,
      "end": 7,
      "targetKey": "[\"connections\",\"connection\",1,\"profile-123\"]"
    }]
  }
}
```

Target identity is the JSON tuple `[sourceId, type, version, id]`. Occurrences use half-open UTF-16 ranges and distinct IDs. An occurrence may retain its own label snapshot when the same target is selected again after a rename; otherwise it uses the target label. Text must exactly match `@` plus that snapshot. Ranges must be ordered, non-overlapping, within bounds, and must not split a surrogate pair. IDs and labels are bounded; type payloads use strict field allowlists. Connection payloads contain only `driver`, with no connection strings or credentials.

One message allows at most 32 occurrences, 16 distinct targets, and 32 KiB of UTF-8 serialized reference metadata, including annotations across multiple text parts. Unknown types/versions, duplicates, unused targets, invalid mappings, and oversized data are rejected before Run creation. The internal runner also validates references. Annotated text retains its whitespace; no trimming is applied without updating ranges. Browser textarea newline normalization happens before capture.

The runner copies references to its user `TextPart`. Existing JSON message storage and the Run-start transaction persist them; no new table or frontend history store is needed. History edits use the existing replacement boundary and append-only audit semantics. References on the old branch remain unchanged.

## Projections and context

Both UI projections derive `metadata.custom.composerReferences` with combined text and shifted ranges. This metadata is a display/editing projection; the outgoing HTTP adapter converts it back to explicit text annotations. Sent user messages render only inline highlights, with no reference details below the message. Details remain available in the composer and history editor, where a local missing connection is displayed as unavailable without changing historical identity. Plain historical `@` text is never upgraded into a reference.

The raw model projection retains the user text and appends compact type-handler descriptions under an explicit user-reference marker. Connection descriptions contain profile ID, name, and driver. This remains a user message and does not populate Runtime Safety State. Token estimation includes the same descriptions. References participate in ordinary active-lineage selection and context compression; original facts remain durable, but references do not pin a permanent connection or guarantee that all old text survives compression.

## Extension boundaries

The frontend implementation lives under `src/features/workbench/agent/composer/`:

- `composer-draft.ts` owns triggers, range transformations, target pruning, and atomic text/reference undo history.
- `composer-registry.ts` constructs immutable source and command registries with duplicate checks. Sources supply availability, cancellable bounded search, capture, and target validation. Failures are isolated by source; aborted searches cannot replace newer results.
- `workbench-composer-registry.ts` explicitly composes built-in sources and commands. It receives a minimal connection directory, never credentials.
- `AgentComposerInput.tsx` provides the shared interaction layer through generic Thread component slots. The textarea keeps native caret, selection, paste, and composition behavior; a non-interactive, accessibility-hidden mirror paints bound ranges. Composition uses the native text layer.
- Commands declare local UI, message-prompt, or conversation-operation actions. Help enumerates registrations; the editor handles selection and ranges without branching on business command IDs. The Runtime independently registers message-prompt identities and versions. Conversation operations go through dedicated endpoints, not ordinary chat submission.

The Runtime independently assembles reference type/version handlers through `createReferenceTypeRegistry`. A source using an existing semantic type needs a source definition and composition entry. A new semantic type also requires its strict schema, deterministic handler, and tests. Neither case should change input keyboard handlers, range maintenance, storage, or generic model-history code. No dynamic plugin loading or unrestricted callback protocol is provided.

## Send lifecycle and recovery

Composer run configuration carries ephemeral current and submitted annotation snapshots. Submission captures the latter before asynchronous attachment completion; subsequent typing cannot change the submitted reference identity. The assistant-ui adapter preserves annotations on optimistic user messages. Synchronous composer publication uses the same `flushTapSync` boundary as assistant-ui's native input, so immediate selection/send cannot use stale text.

Request preparation and transport failures retain a per-thread, in-memory recovery snapshot of the user message, including files and the edit replacement boundary. Recovery is explicit and requires an empty current draft. A recovered edit keeps its replacement intent with the draft until validated submission; clearing that draft abandons the intent so a later ordinary message cannot replace history. Successful submission clears the snapshot. This is not persistent history and does not replay tools. A failed Run already committed by Runtime uses existing message failure presentation.

Focused verification includes `tests/composer-*.test.ts`, `tests/frontend/composer-message-pipeline.test.ts`, and `ai-runtime/tests/composer-references-integration.test.ts`, plus existing Runtime and transport regression suites.

## Persisted message commands

A text input part optionally carries `command: { id, commandId, version, name, start, end }`. Ranges use UTF-16 and must exactly match `/name`; one message may contain at most one command, with no reference intersection. `shared/composer-commands.ts` validates the public shape. `runtime/commands/message-commands.ts` independently resolves supported ID/version/name tuples. Unknown commands/versions and client-supplied `commandPrompt` fields are rejected before creating a Run.

The Runtime snapshots the registered prompt into the durable TextPart's `commandPrompt`. UI projections emit only short text and the public binding; model projection substitutes the server-owned prompt and retains other text and reference descriptions. Token estimation uses that same model projection. Editing a historical message with the same command occurrence preserves its stored prompt snapshot. New semantic behavior must register a new command version; keep old versions supported for editing. Plain text and clipboard contents never become bindings through regex matching alone.

## Manual context compaction

The conversation endpoints are `POST /v1/conversations/:id/compactions` with `{ requestKey, providerId, modelId }`, `GET /v1/conversations/:id/compactions` for the latest operation, and `POST /v1/conversations/:id/compactions/:operationId/cancel`. They use the normal Runtime access authentication. POST is idempotent for the same conversation/key/model; a key reused with different model parameters is rejected. No custom prompt or SQL is accepted.

Migration `0015_runtime_manual_compactions` stores the independent operation ID, idempotency key, terminal-head identity, allocated context request slot and lifecycle. A unique active-operation index and transactional conversation lock prevent concurrent work. The slot is allocated beyond existing plans, usages, activities and manual operations on a terminal head; it never overwrites a Provider request and creates no user/assistant messages or synthetic Run. Run-start commit also checks the lock inside its SQLite transaction. Summary activities remain attached to the real source head and appear after its response.

The service resolves the selected model and existing agent policy, calls the existing planner and summary service with `manual`, and reuses preparation leases, safety projection, source hashes and checkpoint CAS. Manual requests can compact below the automatic threshold but retain the configured recent Run tail. No safe candidate or an equivalent checkpoint returns `not_needed`. A usable manual checkpoint continues to participate in subsequent model context; larger model windows can restore full raw history, and invalid checkpoints do not force an otherwise unnecessary automatic compaction.

Completion stores the next-turn context estimate. Cancellation releases the fenced claim and updates the Activity; late summary completion cannot commit. Failed/cancelled operations release the conversation lock. Startup repairs pending operations as interrupted unless their checkpoint Activity already committed, and never automatically replays a model call. Original message facts, permissions and tool audit remain unchanged. The frontend preserves newly typed drafts during asynchronous submission, exposes cancellation/retry, and refreshes operation state while active and after reload.

Verification adds `tests/composer-commands.test.ts`, `ai-runtime/tests/manual-compaction.test.ts`, and the browser fixture's short-command and compact scenarios.
