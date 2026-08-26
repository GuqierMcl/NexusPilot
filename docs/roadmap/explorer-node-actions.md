# Explorer Node Row Roadmap

> Status: active roadmap. Phase 1, Phase 2, and Phase 3 are implemented; Phase 4 remains planned.

## Goal

Explorer tree rows should support richer node content without overloading the main label area or mixing system state with user-authored visual labels. The near-term target is:

- move connection status out of the standalone status-dot column;
- render connection status as part of the driver icon treatment, with an optional lightweight row rail;
- remove driver abbreviation badges such as `My`, `Pg`, `Re`, and `Or`;
- introduce a right-aligned trailing slot for user tags and future lightweight row actions;
- keep existing selection, double-click primary actions, context menus, lazy loading, and drag sorting behavior intact;
- keep user-defined connection tags as local display metadata only, with no runtime or database-operation semantics.

## Current State

`ConnectionTreeNode` currently renders each row as a non-button row root with a focusable main action area and an optional trailing slot. Connection status no longer occupies a standalone dot column, driver abbreviation badges are removed, and connection user tags render in the trailing slot. The row model is:

```text
[status rail] [main action area: chevron + status-framed icon + label] [trailing slot]
```

This resolves the original two limitations:

- rows can host future interactive controls such as a right-side `MoreHorizontal` button without illegal nested button markup;
- the system connection-state visual no longer competes with the user tag visual language.

The `renderRowShell` hook still wraps the whole rendered row for drag-and-drop behavior. It is not an in-row right slot; row accessories should use the trailing slot.

## Target Row Model

The target row separates structural interaction, main content, and trailing accessories:

```text
[status rail] [main action area: chevron + status-framed icon + label] [trailing slot]
```

The main action area preserves the current tree behavior: selection, double click, primary action, fallback expand/collapse, and context menu. The trailing slot is reserved for non-primary node accessories such as connection tags and future lightweight controls.

### Visual Semantics

- System connection state belongs to the driver icon, not to a standalone color dot.
- User-authored tags belong to the trailing slot, not to the driver icon or status rail.
- The status rail is an auxiliary signal only. It should be visually quieter than the driver icon status treatment.
- The driver icon remains the database-type signal. Status styling may frame it, but must not erase the icon's recognizability.
- The trailing slot should not reserve wide fixed space for optional tag text. Empty tags should not create visible layout holes.

## Roadmap Summary

| Phase | Name | Status | User Outcome |
| --- | --- | --- | --- |
| Phase 1 | Row container foundation | Implemented | Explorer rows can host complex content and future trailing controls without illegal nested buttons. |
| Phase 2 | Connection status visual migration | Implemented | Users read connection state from the driver icon treatment and optional row rail instead of a separate dot. |
| Phase 3 | User tag data model and editing | Implemented | Users can assign an optional text/color tag or color-only marker to a connection without changing runtime behavior. |
| Phase 4 | Trailing-slot actions | Planned | Rows can show lightweight right-side actions such as a three-dot menu without disturbing tree interactions. |

## Phase 1: Row Container Foundation

### Purpose

Replace the current all-row `<button>` with a row container that can safely host a main action area and a trailing slot. This phase should preserve existing behavior before adding new user-visible data.

Phase 1 is implemented as a structural refactor: `ConnectionTreeNode` renders a non-button row root, a focusable main action area, and an optional trailing slot. Phase 2 then removed the old standalone status dot and driver abbreviation badge.

### Scope

- Refactor `ConnectionTreeNode` row markup into a row root, a main action area, and a trailing slot.
- Keep the context menu trigger around the row root or another appropriate non-button container.
- Preserve click selection, double-click primary action, chevron expand/collapse, lazy-load expansion, and row emphasis styling.
- Preserve `renderRowShell` so drag-and-drop wrapping continues to work.
- Add keyboard support equivalent to the current button behavior:
  - `Enter` and `Space` activate the main action behavior;
  - arrow/chevron behavior remains mouse-accessible through the chevron target;
  - `aria-expanded` remains available when the node can expand.
- Add a small internal row accessory boundary. In the first slice this can be an empty trailing container or an internal helper, not a public plugin/contributor API.

### Out Of Scope

- Persisted user tags.
- A visible three-dot button.
- Database or runtime behavior changes.
- Driver-specific row branches.

### Acceptance Criteria

- Existing connection, folder, saved query, and remote node rows still select on click.
- Existing double-click primary actions still work.
- Existing right-click context menus still work.
- Existing local folder/connection drag sorting still works.
- No nested button markup is introduced.
- The trailing slot can host non-primary content without changing the main label truncation behavior.

## Phase 2: Connection Status Visual Migration

### Purpose

Move connection state from the standalone status-dot column into a status-framed driver icon and an optional subtle row rail.

Phase 2 is implemented: connection rows no longer render a standalone status-dot column or driver abbreviation badges. Connection status is expressed through the driver icon frame and a subtle row rail for connected and disconnected/error states.

### Scope

- Remove the standalone `ConnectionStatusIndicator` position from normal row content.
- Remove driver abbreviation badges from connection icons.
- Render connection status through the connection driver icon treatment:
  - `connected`: low-opacity green circular background plus green ring;
  - `loading` / connecting: low-opacity yellow circular background plus yellow ring, while the existing spinner behavior may remain in the chevron slot;
  - `error` / disconnected: low-opacity red circular background plus red ring;
  - idle or unknown: normal driver icon, no status frame.
- Add an optional 2px row rail for connected/error states only, with lower visual weight than the icon frame.
- Keep non-connection nodes on the existing node visual registry path.

### Out Of Scope

- User tag persistence.
- User tag editing.
- Status text badges.
- Driver-specific visual branches in `ConnectionTreeNode`.

### Acceptance Criteria

- Connected and error connection states are visible without the old standalone status dot.
- Loading is still clear and does not block expand/lazy-load behavior.
- The driver icon remains recognizable in every state.
- Generic nodes and remote metadata nodes keep their current icon registry behavior.
- The existing status display mode keeps a clear mapping: `none` hides status frame/rail, `connected-only` frames connected runtime state only, and `all` frames connected, disconnected/error, and unknown states. Loading spinners may remain visible while an operation is pending.

## Phase 3: User Tag Data Model And Editing

### Purpose

Add optional user-defined connection tags as local display metadata. Tags help users visually identify connections, but do not carry environment, risk, permission, or runtime semantics.

Phase 3 is implemented: connection tags are stored as local display metadata on saved connections, edited in the connection dialog, and rendered in the Explorer row trailing slot. Tags do not affect runtime status, remote metadata, query execution, schema mutation, search, sorting, or AI behavior.

### Scope

- Add local storage fields for connection tags: `tag_label` and `tag_color`.
- Mirror the fields through Rust storage models, IPC-facing frontend types, and connection creation/editing flows.
- Render connection tags in the trailing slot:
  - label plus color renders as a compact pill;
  - color without label renders as a small color marker;
  - no label and no color renders nothing.
- Limit tag text length to a small fixed product value, currently 0-8 visible characters.
- Use a fixed color palette with theme-safe contrast instead of arbitrary custom colors.
- Treat the tag as display-only local metadata.

### Out Of Scope

- Filtering, sorting, grouping, or searching by tag.
- Production-environment protection or destructive-operation confirmation.
- AI context enrichment.
- Remote database metadata changes.
- Multi-tag support.

### Acceptance Criteria

- Users can create or edit a connection with no tag, a color-only tag, or a text/color tag.
- Existing connections without tag data continue to load normally.
- Tags render in the row trailing slot without changing the main icon/label alignment.
- Tags do not affect connection runtime, metadata loading, query execution, schema mutation, or AI behavior.
- The docs explicitly call tags display-only metadata.

## Phase 4: Trailing-Slot Actions

### Purpose

Allow future lightweight row actions, such as a three-dot menu button, to share the same trailing slot as other row accessories.

### Scope

- Define when trailing controls are visible, for example hover, focus-within, or selected row.
- Ensure trailing controls stop event propagation as needed so they do not select, double-click, expand, or start drag unintentionally.
- Keep primary actions and full context-menu action generation under the existing Explorer action registry.
- Avoid moving driver-specific menus into `ConnectionTreeNode`.

### Out Of Scope

- Replacing the context menu system.
- Adding driver-specific inline action branches.
- Adding heavy toolbar behavior to every tree row.

### Acceptance Criteria

- A future trailing action can be clicked without triggering row selection or drag.
- Keyboard focus can reach the trailing action when it is visible.
- Context-menu behavior remains available for the whole row.
- The row remains visually calm when no trailing action is relevant.

## Implementation Notes

Expected implementation touch points:

- `src/features/workbench/explorer/components/ConnectionTreeNode.tsx`
- `src/features/workbench/explorer/components/ExplorerNodeIcon.tsx`
- `src/features/workbench/explorer/components/ConnectionStatusIndicator.tsx` (removed in Phase 2)
- `src/features/workbench/explorer/components/ConnectionTree.tsx`
- `src/features/workbench/explorer/driver-configs/types.ts`
- `src/features/workbench/explorer/driver-configs/*`
- `src/features/workbench/explorer/types.ts`
- `src/lib/tauri/connections.ts`
- `src-tauri/src/repository/connection_repository.rs`
- `src-tauri/src/commands/connection_commands.rs`
- matching SQLite migrations and frontend connection form components for Phase 3

Testing and verification should include:

- `bun run tsc --noEmit`
- focused manual verification of click, double-click, right-click, drag, chevron expansion, remote lazy loading, hover/focus styling, and keyboard activation
- screenshot or visual inspection of connected, loading, error, idle, selected, hover, and dragged rows
- storage migration checks when Phase 3 adds persisted tag fields

## Documentation Sync

- `docs/architecture/EXPLORER_TREE.md` should remain the current implementation reference and note planned row evolution until each phase lands.
- `docs/guides/WORKBENCH_REGISTRY_CONSTRAINTS.md` records the trailing-slot and status/tag separation constraints, and should be updated from planning language to current implementation language as phases land.
- When Phase 3 lands, update storage/connection docs or the relevant architecture section to record tag fields as local display metadata.
