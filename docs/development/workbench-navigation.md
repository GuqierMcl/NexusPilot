# Workbench Navigation Guide

> Status: current product and implementation constraint for `NavigationRail` and adjacent workbench navigation surfaces.

This guide defines what belongs in the left `NavigationRail`, what should remain inside existing work surfaces, and where the next implementation slice should start. NexusPilot is now developed as a product-complete, iterative database workbench: navigation should express durable product structure, not temporary placeholders.

## 1. NavigationRail Role

`NavigationRail` is the first-level information architecture for the main workbench. A rail item is a product promise: it tells users that the destination is a first-class work surface they can return to frequently.

Rail items must not be used as placeholders for undeveloped ideas. If a feature does not yet have a real surface, persistence model, or workflow, do not show it in the rail.

## 2. Top-Level Entry Criteria

A feature can become a top-level `NavigationRail` item only when most of these are true:

1. It works across connections, tabs, and sessions.
2. Users return to it repeatedly during normal database work.
3. It has its own search, filtering, detail, or operation surface.
4. It can grow into a durable product area rather than a narrow utility.
5. It deserves permanent visual weight next to the main workbench.

Features that fail these criteria should live inside an existing surface, a settings section, a context menu, or a content tab until they mature.

## 3. Current Rail Information Architecture

| Entry | Placement | Current rule |
| --- | --- | --- |
| Connections | Top rail item, default active | Shows the current left explorer connection tree. This is the primary workbench resource entry. |
| Execution History | Future top rail item | Eligible for the rail, but only after persistent execution records, filtering, detail view, and reopen/reuse flows exist. Until then, do not show a placeholder. |
| Settings | Bottom rail item | Opens the settings dialog/workspace. Keep it visually separated from workbench resource entries. |
| SSH tunnels | Not a top rail item yet | Important connection infrastructure, but currently too narrow for first-level rail placement. Manage it under Connections or Settings until it grows into a broader access asset center. |
| Code snippets / knowledge context | Not shown | Do not show these as placeholders until they have real product surfaces and persistence/workflow backing. |
| Driver quick access | Not shown | Keep the middle rail section empty until there is a real driver-level workflow such as favorites, filtered connection views, or fast connection creation. |

## 4. Connections Entry

The Connections rail item is the default selected item. It maps to the existing `WorkbenchExplorerPanel` and should preserve the current connection tree behavior: folders, connection profiles, saved queries, lazy remote metadata, and live connection status.

The first implementation slice should make the rail honest by replacing placeholder top actions with a real active Connections item and keeping Settings at the bottom. This slice should not add SSH management or execution history implementation.

## 5. SSH Tunnel Assets

SSH tunnel management is necessary, but it should start as connection infrastructure rather than a top-level rail destination.

Initial placement options:

- inside the Connections left panel as a secondary management view, for example `Connections / SSH tunnels`;
- inside connection edit/create dialogs as "select saved SSH tunnel" and "save this tunnel";
- inside Settings as a future "Network and access" or "Credentials and access" section.

Initial product constraints:

- A database connection must still be able to embed or copy SSH tunnel config so the existing runtime path keeps working.
- Saved SSH tunnels should reduce duplicated bastion configuration across database connections.
- Secrets such as SSH passwords, private-key passphrases, database passwords, and API keys must not be written to logs, execution history, or unrestricted debug output.
- Do not promote SSH tunnels to a top-level rail item unless the area expands into a broader access asset center, such as SSH tunnels, proxies, TLS certificates, trusted host keys, and credential policy.

## 6. Execution History

Execution History is a strong candidate for a future top-level rail item because it can become the workbench's factual memory: executed SQL, schema changes, Redis mutations, errors, duration, and reuse/reopen paths.

It should enter the rail only after these minimum capabilities exist:

- persistent execution records in local storage;
- a content tab or full work surface with filtering and search;
- detail view for SQL, DDL, mutation summary, status, error code/message, timing, and context;
- reopen/reuse actions, such as opening a SQL record in a SQL editor tab;
- explicit redaction rules for secrets and sensitive payloads.

The recording boundary should focus on user-intent actions:

- record `execute_sql`;
- record table change-set commits and transaction begin/commit/rollback;
- record schema mutations such as create/update/drop database or table;
- record Redis create/set/delete/rename/ttl mutations;
- do not record routine browsing and loading commands such as `list_containers`, `browse_table_data`, or `get_key_value`.

The rail action for Execution History should open or focus an `execution_history` content tab, not replace the Connections left panel with a cramped history list. A compact "recent activity" left-panel view can be considered later, but the canonical surface should be a content tab.

## 7. Navigation Architecture Constraints

Keep the public workbench shell small:

- `NavigationRail` renders actions and active state; it should not own feature-specific business logic.
- `MainLayout` should not grow a long chain of product-specific `if`/`switch` branches.
- When a second real left-panel activity is added, introduce a small navigation store and/or left-activity registry before adding more branches.
- Content surfaces opened from the rail should use the existing Content Tab registry/lifecycle pattern.
- Left-panel resource surfaces should be separated from content-tab work surfaces: resource browsing belongs left; searchable records and detailed work views belong in content.

Recommended future route:

1. First slice: rail honesty. Show Connections and Settings only; remove placeholder top actions.
2. Second slice: introduce a navigation model/store only when there is at least one additional real destination.
3. Third slice: build SSH tunnel assets inside Connections or Settings, not as a rail item.
4. Fourth slice: build persistent Execution History and expose it as a rail item after the content tab is useful.

## 8. Review Checklist

Before adding a `NavigationRail` item, answer these questions in the PR or design note:

- What real surface does the item open today?
- Does the feature meet the top-level entry criteria in this guide?
- Is this a first-level workbench area, or should it live under Connections, Settings, a context menu, or a content tab?
- Does the item have persistence and a useful empty state?
- If it is future-facing, why is it visible before the workflow exists?

If the answer is "placeholder", do not add the rail item.
