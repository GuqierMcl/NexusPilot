import { expect, test } from "bun:test";
import { ACTIVE_TAB_PART, parseActiveTabContext, readActiveTabPart } from "../shared/active-tab-context";
import { aiTabRegistry, createAiTabRegistry, METADATA_ONLY_TAB_CAPABILITIES } from "../src/features/workbench/agent/composer/active-tab-registry";
import { createComposerMessage } from "../src/features/workbench/agent/runtime/composer-message-adapter";
import { buildRunCreateRequestFromAiSdkMessages } from "../src/features/workbench/agent/runtime/run-request-adapter";
import type { WorkbenchTab } from "../src/store/slices/workbench-tabs-slice";
import type { AppendMessage } from "@assistant-ui/react";
import type { UIMessage } from "ai";

const tab = { id: "tab-1", type: "sql_editor", title: "月度统计", isDirty: true, isPinned: false,
  payload: { profileId: "p-1", tabRuntimeId: "runtime-1", runtime: {}, initialContext: { database: "initial", schema: null } },
} as WorkbenchTab;
const input = { connections: [{ id: "p-1", driver: "mysql", password: "do-not-copy" }], sqlContexts: { "tab-1": { database: "actual", schema: null } } };
const snapshot = aiTabRegistry.capture(tab, input)!;

test("tab registry captures current metadata without payload, credentials or text", () => {
  expect(snapshot.connection).toEqual({ id: "p-1", driver: "mysql", database: "actual", schema: null });
  expect(snapshot.capabilities).toEqual({ metadata: true, content: false, actions: [] });
  expect(JSON.stringify(snapshot)).not.toContain("do-not-copy");
  expect(JSON.stringify(snapshot)).not.toContain("runtime-1");
  expect(aiTabRegistry.capture(undefined, input)).toBeUndefined();
  expect(aiTabRegistry.capture({ ...tab, type: "unknown" } as unknown as WorkbenchTab, input)).toBeUndefined();
  expect(aiTabRegistry.capture(tab, input)?.revision).toBe(snapshot.revision);
  expect(aiTabRegistry.capture({ ...tab, title: "新标题" }, input)?.revision).not.toBe(snapshot.revision);
  expect(aiTabRegistry.capture(tab, { ...input, sqlContexts: {} })?.revision).not.toBe(snapshot.revision);
});

test("registrations are explicit and duplicates fail", () => {
  const definition = { type: "dashboard" as const, describe: () => undefined, capabilities: METADATA_ONLY_TAB_CAPABILITIES };
  expect(() => createAiTabRegistry([definition, definition])).toThrow("Duplicate");
  const registry = createAiTabRegistry([definition]);
  expect(registry.capture(tab, input)).toBeUndefined();
  expect(registry.capture({ ...tab, type: "dashboard", payload: {} }, input)?.type).toBe("dashboard");
});

test("strict snapshot rejects unknown versions, content, capabilities and excessive metadata", () => {
  for (const changed of [
    { version: 2 }, { type: "unknown" }, { sql: "SELECT *" }, { title: "x".repeat(257) },
    { capabilities: { ...snapshot.capabilities, content: true } },
    { capabilities: { ...snapshot.capabilities, actions: ["run-query"] } },
    { connection: { ...snapshot.connection, password: "secret" } },
  ]) expect(() => parseActiveTabContext({ ...snapshot, ...changed })).toThrow();
  expect(() => parseActiveTabContext({ ...snapshot, tabId: "中".repeat(256), title: "中".repeat(256), connection: { id: "中".repeat(256), driver: "中".repeat(256), database: "中".repeat(256), schema: "中".repeat(256) } })).toThrow("大小上限");
});

function message(custom: Record<string, unknown>, content: AppendMessage["content"] = [{ type: "text", text: "解释这段查询" }]): UIMessage {
  return { id: "ui-1", ...createComposerMessage({ role: "user", content, runConfig: { custom } } as AppendMessage) } as UIMessage;
}
const request = (msg: UIMessage) => buildRunCreateRequestFromAiSdkMessages({ messages: [msg], selectedModel: { providerId: "p", modelId: "m" } });

test("submitted snapshot wins over later draft and is transported separately from body", () => {
  const draft = { ...snapshot, title: "后来选中的标签页" };
  const sent = message({ submittedActiveTabContext: snapshot, activeTabDraft: { mode: "snapshot", snapshot: draft } });
  expect(readActiveTabPart(sent.parts)).toEqual(snapshot);
  const body = request(sent);
  expect(body.activeTabContext).toEqual(snapshot);
  expect(body.input.parts).toEqual([{ type: "text", text: "解释这段查询" }]);
  draft.title = "又变了";
  expect(body.activeTabContext?.title).toBe("月度统计");
});

test("editing explicit removal replaces existing native data part and never leaks into text", () => {
  const native: AppendMessage["content"] = [{ type: "text", text: "新问题" }, { type: "data", name: "active-tab-context", data: snapshot }];
  const omitted = message({ submittedActiveTabContext: null }, native);
  expect(readActiveTabPart(omitted.parts)).toBeUndefined();
  expect(request(omitted).activeTabContext).toBeUndefined();
  const retained = message({}, native);
  expect(request(retained).activeTabContext).toEqual(snapshot);
  expect(retained.parts.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("新问题");
});

test("duplicate and data-only input cannot start a Run", () => {
  const sent = message({ submittedActiveTabContext: snapshot });
  expect(() => request({ ...sent, parts: [...sent.parts, { type: ACTIVE_TAB_PART, data: snapshot }] })).toThrow();
  expect(() => request({ ...sent, parts: [{ type: ACTIVE_TAB_PART, data: snapshot }] })).toThrow();
});
