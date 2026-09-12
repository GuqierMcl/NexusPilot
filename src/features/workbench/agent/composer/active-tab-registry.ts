import type { TabType, WorkbenchTab } from "@/store/slices/workbench-tabs-slice";
import type { SqlExecutionContext } from "@/types/saved-queries";
import { parseActiveTabContext, type ActiveTabContext } from "@contracts/active-tab-context";
import { type SqlEditorContentCapture } from "./sql-editor-content-capture";
import { buildSqlEditorContentCapture } from "./sql-editor-content-capture";

export interface TabMetadataInput {
  connections: readonly { id: string; driver: string }[];
  sqlContexts: Readonly<Record<string, SqlExecutionContext>>;
  sqlEditors?: Readonly<Record<string, { sqlText: string; editorSelection?: { text: string; start: number; end: number } | null }>>;
}
export interface AiTabRegistration {
  type: TabType;
  capabilities: ActiveTabContext["capabilities"];
  describe: (tab: WorkbenchTab, input: TabMetadataInput) => ActiveTabContext["connection"];
  captureContent?: (tab: WorkbenchTab, input: TabMetadataInput) => SqlEditorContentCapture | undefined;
}

function connection(tab: WorkbenchTab, input: TabMetadataInput): ActiveTabContext["connection"] {
  if (!("profileId" in tab.payload)) return undefined;
  const id = tab.payload.profileId;
  const driver = input.connections.find((item) => item.id === id)?.driver;
  return { id, ...(driver ? { driver } : {}) };
}
function containerContext(tab: WorkbenchTab, input: TabMetadataInput): ActiveTabContext["connection"] {
  const base = connection(tab, input);
  if (!base) return undefined;
  const payload = tab.payload;
  const container = ("container" in payload ? payload.container : null)
    ?? ("parentContainer" in payload ? payload.parentContainer : null);
  return { ...base, database: container?.database ?? null, schema: container?.schema ?? null };
}

export function createAiTabRegistry(definitions: readonly AiTabRegistration[]) {
  const registry = new Map<TabType, AiTabRegistration>();
  for (const definition of definitions) {
    if (registry.has(definition.type)) throw new Error(`Duplicate AI tab registration: ${definition.type}`);
    registry.set(definition.type, Object.freeze({ ...definition }));
  }
  return Object.freeze({
    capture(tab: WorkbenchTab | undefined, input: TabMetadataInput): ActiveTabContext | undefined {
      if (!tab) return undefined;
      const registration = registry.get(tab.type);
      if (!registration) return undefined;
      const metadata = {
        version: 1 as const, tabId: tab.id, type: tab.type, title: tab.title,
        dirty: tab.isDirty,
        connection: registration.describe(tab, input),
        capabilities: registration.capabilities,
      };
      // A metadata revision, deliberately independent of editor text and result data.
      let hash = 2166136261;
      for (const char of JSON.stringify(metadata)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return parseActiveTabContext({ ...metadata, revision: `metadata-v1-${(hash >>> 0).toString(16)}` });
    },
    captureContent(tab: WorkbenchTab | undefined, input: TabMetadataInput): SqlEditorContentCapture | undefined {
      if (!tab) return undefined;
      return registry.get(tab.type)?.captureContent?.(tab, input);
    },
  });
}

export const METADATA_ONLY_TAB_CAPABILITIES: ActiveTabContext["capabilities"] = { metadata: true, content: false, actions: [] };

const metadataRegistrations: Omit<AiTabRegistration, "capabilities">[] = [
  { type: "sql_editor", describe: (tab, input) => {
    const base = connection(tab, input);
    const context = input.sqlContexts[tab.id] ?? (tab.type === "sql_editor" ? tab.payload.initialContext : null);
    return base ? { ...base, database: context?.database ?? null, schema: context?.schema ?? null } : undefined;
  }, captureContent: (tab, input) => {
    if (tab.type !== "sql_editor") return undefined;
    const state = input.sqlEditors?.[tab.id];
    return buildSqlEditorContentCapture({
      sqlText: state?.sqlText ?? "",
      selectedText: state?.editorSelection?.text,
      selectionStart: state?.editorSelection?.start,
      selectionEnd: state?.editorSelection?.end,
    });
  } },
  { type: "table_data", describe: containerContext },
  { type: "table_design", describe: containerContext },
  { type: "clickhouse_table_design", describe: containerContext },
  { type: "clickhouse_view_design", describe: containerContext },
  { type: "key_value", describe: (tab, input) => {
    const base = connection(tab, input);
    return base && tab.type === "key_value" ? { ...base, database: String(tab.payload.dbIndex) } : base;
  } },
  { type: "json_viewer", describe: () => undefined },
  { type: "graph_topology", describe: () => undefined },
  { type: "dashboard", describe: () => undefined },
];
export const aiTabRegistry = createAiTabRegistry(metadataRegistrations.map((registration) => ({
  ...registration, capabilities: METADATA_ONLY_TAB_CAPABILITIES,
})));
