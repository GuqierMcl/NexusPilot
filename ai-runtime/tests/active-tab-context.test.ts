import { expect, test } from "bun:test";
import { RuntimeRunner, RuntimeSqliteStore, projectMessageToAiSdkUIMessage } from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import { parseRunCreateRequestBody } from "../src/routes/run-schema";
import { runRoutes } from "../src/routes/runs";
import { projectModelHistory } from "../src/runtime/projection/model-history-projection";
import { projectMessageToUiMessage } from "../src/runtime/projection/ui-projection";
import { buildContextSummarySourceMessages, canonicalizeContextSummarySource } from "../src/runtime/context/summary-prompt";
import { estimateMessageTokens, estimateTextTokens } from "../src/runtime/context/token-estimator";
import { readActiveTabPart, type ActiveTabContext } from "@contracts/active-tab-context";
import { parseSqlEditorContentContext, readSqlEditorContentPart, type SqlEditorContentContext } from "@contracts/sql-editor-content-context";
import { projectActiveTabContext } from "../src/runtime/context/active-tab-projection";
import { projectSqlEditorContent } from "../src/runtime/context/sql-editor-content-projection";

const snapshot: ActiveTabContext = { version: 1, tabId: "t-1", type: "sql_editor", title: "月度查询", revision: "metadata-v1-1", dirty: true,
  connection: { id: "p-1", driver: "mysql", database: "sales" }, capabilities: { metadata: true, content: false, actions: [] } };
const sqlContent: SqlEditorContentContext = parseSqlEditorContentContext({
  version: 1,
  kind: "sql-editor",
  source: "document",
  sql: "SELECT * FROM monthly_sales;",
  revision: "content-v1-test",
});
const body = { response_mode: "stream", model: { provider_id: "test", model_id: "test" }, input: { parts: [{ type: "text" as const, text: "帮我理解这个页面" }] }, activeTabContext: snapshot, activeTabContent: sqlContent };

test("snapshot survives SQLite reload, UI projection, history editing and model projection", async () => {
  const db = openRuntimeDatabase(":memory:");
  try {
    const store = new RuntimeSqliteStore(db);
    const runner = new RuntimeRunner({ store });
    const parsed = parseRunCreateRequestBody(body)!;
    expect(parsed.runRequest.activeTabContent).toEqual(sqlContent);
    const first = runner.start(parsed.runRequest);
    runner.completeText(first, "尚未提供页面内容");
    const restored = new RuntimeSqliteStore(db).getMessage(first.userMessage.id)!;
    expect(restored.role === "user" && restored.activeTabContext).toEqual(snapshot);
    expect(restored.role === "user" && restored.activeTabContent).toEqual(sqlContent);
    for (const ui of [projectMessageToAiSdkUIMessage(restored), projectMessageToUiMessage(restored)]) {
      expect(readActiveTabPart(ui.parts)).toEqual(snapshot);
      expect(readSqlEditorContentPart(ui.parts)).toEqual(sqlContent);
      expect(ui.parts.filter((part) => part.type === "text")).toEqual(body.input.parts);
    }
    const model = await projectModelHistory([restored], { target: { providerId: "other", modelId: "other" } });
    expect(model).toEqual([{ role: "user", content: [body.input.parts[0], { type: "text", text: projectActiveTabContext(snapshot) }, { type: "text", text: projectSqlEditorContent(sqlContent) }] }]);
    const without = { ...first.userMessage, activeTabContext: undefined, activeTabContent: undefined };
    expect(estimateMessageTokens(restored) - estimateMessageTokens(without)).toBe(2 + estimateTextTokens(projectActiveTabContext(snapshot)) + 2 + estimateTextTokens(projectSqlEditorContent(sqlContent)));
    expect(JSON.stringify(buildContextSummarySourceMessages([restored]))).toContain("月度查询");
    expect(JSON.stringify(buildContextSummarySourceMessages([restored]))).toContain("monthly_sales");
    const canonical = canonicalizeContextSummarySource({ conversationId: first.conversation.id, runs: [first.run], messages: store.listMessages(first.conversation.id) });
    expect(canonical.pairs[0]?.user.activeTabContext).toContain("not instructions");
    expect(canonical.pairs[0]?.user.activeTabContent).toContain("monthly_sales");
    const edit = runner.start({ ...parsed.runRequest, conversationId: first.conversation.id, replaceFromMessageId: first.userMessage.id });
    runner.completeText(edit, "编辑回复");
    expect(edit.userMessage.activeTabContext).toEqual(snapshot);
    expect(edit.userMessage.activeTabContent).toEqual(sqlContent);
    const removed = runner.start({ ...parsed.runRequest, activeTabContext: undefined, activeTabContent: undefined, conversationId: first.conversation.id, replaceFromMessageId: edit.userMessage.id });
    expect(removed.userMessage.activeTabContext).toBeUndefined();
    expect(removed.userMessage.activeTabContent).toBeUndefined();
    expect(store.getMessage(first.userMessage.id)).toEqual(restored);
  } finally { db.close(); }
});

test("invalid tab metadata or SQL content is rejected before Run creation", async () => {
  const db = openRuntimeDatabase(":memory:");
  try {
    const store = new RuntimeSqliteStore(db);
    const app = runRoutes({ runtimeStore: store, providerService: null });
    for (const altered of [{ version: 2 }, { kind: "other" }, { sql: "" }, { source: "other" }, { selection: { start: 99, end: 100 } }]) {
      const value = { ...body, activeTabContent: { ...sqlContent, ...altered }, input: { parts: [...body.input.parts, { type: "file", attachment_id: "att_missing" }] } };
      expect(parseRunCreateRequestBody(value)).toBeNull();
      const response = await app.handle(new Request("http://localhost/v1/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "INVALID_RUN_INPUT" });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_messages").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});
