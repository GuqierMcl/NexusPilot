import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type FC, type PropsWithChildren } from "react";
import { useAui } from "@assistant-ui/react";
import { flushTapSync } from "@assistant-ui/tap";
import { useWorkbenchTabsStore } from "@/store/slices/workbench-tabs-slice";
import { useTabRuntimeStateStore } from "@/store/slices/tab-runtime-state-slice";
import { useExplorerStore } from "@/store/slices/explorer-slice";
import { parseActiveTabContext, type ActiveTabContext } from "../../../../../shared/active-tab-context";
import { aiTabRegistry } from "./active-tab-registry";

export interface ActiveTabSource { capture: () => ActiveTabContext | undefined }
const EMPTY_SOURCE: ActiveTabSource = { capture: () => undefined };
const ActiveTabSourceContext = createContext<ActiveTabSource>(EMPTY_SOURCE);
export const ActiveTabSourceProvider = ActiveTabSourceContext.Provider;

export function captureWorkbenchTab(tabId: string | null): ActiveTabContext | undefined {
  const tab = useWorkbenchTabsStore.getState().tabs.find((item) => item.id === tabId);
  const sqlContext = tab && useTabRuntimeStateStore.getState().sqlEditorByTabId[tab.id]?.context;
  return aiTabRegistry.capture(tab, {
    connections: useExplorerStore.getState().connections.map(({ id, driver }) => ({ id, driver })),
    sqlContexts: tab && sqlContext ? { [tab.id]: sqlContext } : {},
  });
}

function captureActiveTab(): ActiveTabContext | undefined {
  return captureWorkbenchTab(useWorkbenchTabsStore.getState().activeTabId);
}

export const WorkbenchActiveTabProvider: FC<PropsWithChildren> = ({ children }) => {
  const tabs = useWorkbenchTabsStore((state) => state.tabs);
  const activeTabId = useWorkbenchTabsStore((state) => state.activeTabId);
  const sqlContext = useTabRuntimeStateStore((state) => activeTabId ? state.sqlEditorByTabId[activeTabId]?.context : undefined);
  const connections = useExplorerStore((state) => state.connections);
  // The function reads fresh stores during submit; metadata changes update the preview.
  const source = useMemo(() => ({ capture: captureActiveTab }), [tabs, activeTabId, sqlContext, connections]);
  return <ActiveTabSourceProvider value={source}>{children}</ActiveTabSourceProvider>;
};

export type ActiveTabDraft = { mode: "follow" } | { mode: "omit" } | { mode: "snapshot"; snapshot: ActiveTabContext };
export function resolveActiveTabDraft(draft: ActiveTabDraft, capture: ActiveTabSource["capture"]): ActiveTabContext | undefined {
  return draft.mode === "omit" ? undefined : draft.mode === "snapshot" ? parseActiveTabContext(draft.snapshot) : capture();
}

export function useActiveTabDraft(input: { editing?: boolean; initial?: ActiveTabContext; text: string; attachmentCount: number }) {
  const aui = useAui();
  const source = useContext(ActiveTabSourceContext);
  const [draft, setDraft] = useState<ActiveTabDraft>(() => {
    if (input.editing) return input.initial ? { mode: "snapshot", snapshot: input.initial } : { mode: "omit" };
    return (aui.composer().getState().runConfig.custom?.activeTabDraft as ActiveTabDraft | undefined) ?? { mode: "follow" };
  });
  const current = useRef(draft);
  const update = useCallback((next: ActiveTabDraft): void => {
    current.current = next;
    setDraft(next);
    const composer = aui.composer();
    flushTapSync(() => composer.setRunConfig({
      ...composer.getState().runConfig,
      custom: { ...composer.getState().runConfig.custom, activeTabDraft: next },
    }));
  }, [aui]);
  const hasContent = Boolean(input.text || input.attachmentCount);
  const previousContent = useRef(hasContent);
  useLayoutEffect(() => {
    if (!input.editing && previousContent.current && !hasContent) update({ mode: "follow" });
    previousContent.current = hasContent;
  }, [hasContent, input.editing, update]);
  let snapshot: ActiveTabContext | undefined;
  let error: string | undefined;
  try { snapshot = resolveActiveTabDraft(draft, source.capture); }
  catch (cause) { error = cause instanceof Error ? cause.message : "无法获取标签页信息"; }
  return {
    snapshot, error,
    remove: (): void => update({ mode: "omit" }),
    restore: (value: ActiveTabContext | undefined): void => update(value ? { mode: "snapshot", snapshot: value } : { mode: "omit" }),
    capture: (): ActiveTabContext | undefined => resolveActiveTabDraft(current.current, source.capture),
  };
}
