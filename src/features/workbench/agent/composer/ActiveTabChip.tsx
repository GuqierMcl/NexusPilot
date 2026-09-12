import { AppWindow, Braces, Database, FileCode2, Network, PanelsTopLeft, Table2, Wrench, X } from "lucide-react";
import { useMemo, type FC } from "react";
import { cn } from "@/lib/utils";
import type { ActiveTabContext } from "@contracts/active-tab-context";
import { useWorkbenchTabsStore } from "@/store/slices/workbench-tabs-slice";
import { useTabRuntimeStateStore } from "@/store/slices/tab-runtime-state-slice";
import { useExplorerStore } from "@/store/slices/explorer-slice";
import { captureWorkbenchTab } from "./active-tab-context";

const icons = {
  sql_editor: FileCode2, table_data: Table2, key_value: Database,
  table_design: Wrench, clickhouse_table_design: Wrench, clickhouse_view_design: Wrench,
  json_viewer: Braces, graph_topology: Network, dashboard: PanelsTopLeft,
};
export const ActiveTabChip: FC<{ snapshot: ActiveTabContext; onRemove?: () => void; historical?: boolean; content?: boolean; contentWarning?: boolean }> = ({ snapshot, onRemove, historical, content, contentWarning }) => {
  const tab = useWorkbenchTabsStore((state) => state.tabs.find((item) => item.id === snapshot.tabId));
  const sqlContext = useTabRuntimeStateStore((state) => state.sqlEditorByTabId[snapshot.tabId]?.context);
  const connections = useExplorerStore((state) => state.connections);
  const changed = useMemo(() => {
    if (!historical || !tab) return false;
    try { return captureWorkbenchTab(snapshot.tabId)?.revision !== snapshot.revision; }
    catch { return true; }
  }, [historical, tab, sqlContext, connections, snapshot.tabId, snapshot.revision]);
  const Icon = icons[snapshot.type] ?? AppWindow;
  const state = historical && !tab ? "；原标签页已关闭" : changed ? "；标签页状态已变化" : "";
  const description = content
    ? `本条消息携带标签页信息和 SQL 内容${state}`
    : contentWarning
      ? `本条消息携带标签页信息，SQL 内容过长未附加${state}`
      : `本条消息携带标签页信息，未包含页面内容${state}`;
  return (
    <span data-slot="active-tab-chip" title={`${snapshot.title} · ${description}`}
      className={cn("inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground", onRemove && "bg-muted/50")}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="max-w-48 truncate">{snapshot.title}</span>
      <span className="sr-only">{description}</span>
      {onRemove && <button type="button" aria-label={`移除标签页上下文 ${snapshot.title}`} onClick={onRemove}
        className="rounded p-0.5 hover:bg-muted focus-visible:outline-2"><X className="size-3" aria-hidden="true" /></button>}
    </span>
  );
};
