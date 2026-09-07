import { expect, test } from "bun:test";
import { runRoutes } from "../src/routes/runs";

test("invalid references with attachments return an input error instead of blaming the attachment", async () => {
  const app = runRoutes({ providerService: null, runtimeStore: null });
  const response = await app.handle(new Request("http://localhost/v1/runs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, input: { parts: [
      { type: "text", text, references: { ...references, version: 99 } },
      { type: "file", attachment_id: "att_fixture" },
    ] } }),
  }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "INVALID_RUN_INPUT" });
});
import {
  RuntimeRunner,
  RuntimeSqliteStore,
  projectMessageToAiSdkUIMessage,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import { parseRunCreateRequestBody } from "../src/routes/run-schema";
import { projectMessageToUiMessage } from "../src/runtime/projection/ui-projection";
import { projectModelHistory } from "../src/runtime/projection/model-history-projection";
import {
  estimateMessageTokens,
  estimateTextTokens,
  CONTEXT_ESTIMATOR_OVERHEAD,
} from "../src/runtime/context/token-estimator";
import {
  readComposerReferenceMetadata,
  referenceKey,
  projectReferencedText,
  type TextReferences,
} from "../../shared/composer-references";

const target = {
  sourceId: "connections",
  type: "connection",
  version: 1,
  id: "profile-1",
  label: "开发😀",
  data: { driver: "postgresql" },
};
const text = "  看 @开发😀\r\n ";
const references: TextReferences = {
  version: 1,
  targets: [target],
  occurrences: [
    { id: "occ-1", start: 4, end: 9, targetKey: referenceKey(target) },
  ],
};
const body = {
  response_mode: "stream",
  model: { provider_id: "test", model_id: "test" },
  input: { parts: [{ type: "text", text, references }] },
};

test("short commands persist their server snapshot and UI never exposes expanded prompts", async () => {
  const command = { id: "cmd-1", commandId: "explain", name: "explain", version: 1, start: 2, end: 10 };
  const part = { type: "text", text: "  /explain SELECT 1 ", command };
  const request = { ...body, input: { parts: [part] } };
  const parsed = parseRunCreateRequestBody(request)!;
  expect(parsed).not.toBeNull();
  expect(parseRunCreateRequestBody({ ...request, input: { parts: [{ ...part, commandPrompt: "spoofed" }] } })).toBeNull();
  expect(parseRunCreateRequestBody({ ...request, input: { parts: [{ ...part, command: { ...command, commandId: "compact", name: "compact" } }] } })).toBeNull();
  const db = openRuntimeDatabase(":memory:");
  try {
    const store = new RuntimeSqliteStore(db);
    const runner = new RuntimeRunner({ store });
    const first = runner.start(parsed.runRequest);
    runner.completeText(first, "说明");
    const restored = new RuntimeSqliteStore(db).getMessage(first.userMessage.id)!;
    expect(restored.parts[0]).toMatchObject({ text: part.text, command, commandPrompt: "请解释以下 SQL 的含义与执行逻辑，并指出需要注意的问题：" });
    for (const projection of [projectMessageToAiSdkUIMessage(restored), projectMessageToUiMessage(restored)]) {
      expect(readComposerReferenceMetadata(projection.metadata)?.command).toEqual(command);
      expect(JSON.stringify(projection)).not.toContain("请解释以下 SQL");
    }
    expect(JSON.stringify(await projectModelHistory([restored], { target: { providerId: "test", modelId: "test" } }))).toContain("请解释以下 SQL");
    const historical = structuredClone(restored);
    if (historical.parts[0]?.type === "text") historical.parts[0].commandPrompt = "historical prompt snapshot";
    store.saveMessage(historical);
    const edit = runner.start({ ...parsed.runRequest, conversationId: first.conversation.id, replaceFromMessageId: first.userMessage.id });
    expect(edit.userMessage.parts[0]).toMatchObject({ commandPrompt: "historical prompt snapshot" });
  } finally { db.close(); }
});

test("HTTP references survive transaction, raw and both UI projections, model switch and edit lineage", async () => {
  const parsed = parseRunCreateRequestBody(body)!;
  expect(parsed.runRequest.parts![0]).toMatchObject({ text, references });
  const db = openRuntimeDatabase(":memory:");
  try {
    const store = new RuntimeSqliteStore(db);
    const runner = new RuntimeRunner({ store, appVersion: "test" });
    const first = runner.start(parsed.runRequest);
    runner.completeText(first, "说明");
    // Reopening the store reads serialized facts, not frontend state.
    const reopened = new RuntimeSqliteStore(db);
    const restored = reopened.getMessage(first.userMessage.id)!;
    expect(restored.parts[0]).toMatchObject({ text, references });
    for (const projected of [
      projectMessageToAiSdkUIMessage(restored),
      projectMessageToUiMessage(restored),
    ]) {
      const view = readComposerReferenceMetadata(projected.metadata)!;
      expect(view.text).toBe(text);
      expect(view.references?.targets).toEqual([target]);
      expect(view.references?.occurrences[0]).toMatchObject(
        references.occurrences[0]!,
      );
    }
    const modelText = projectReferencedText({ text, references });
    const projected = await projectModelHistory([restored], {
      target: { providerId: "another", modelId: "another" },
    });
    expect(projected).toEqual([
      { role: "user", content: [{ type: "text", text: modelText }] },
    ]);
    expect(estimateMessageTokens(restored)).toBe(
      CONTEXT_ESTIMATOR_OVERHEAD.message +
        CONTEXT_ESTIMATOR_OVERHEAD.part +
        estimateTextTokens(modelText),
    );
    const second = runner.start({
      ...parsed.runRequest,
      conversationId: first.conversation.id,
      replaceFromMessageId: first.userMessage.id,
      parts: [{ type: "text", text: "改为普通文字 @开发😀" }],
    });
    runner.completeText(second, "新回答");
    expect(
      store.listActiveLineageMessages(first.conversation.id).map((m) => m.id),
    ).not.toContain(first.userMessage.id);
    expect(store.getMessage(first.userMessage.id)?.parts[0]).toMatchObject({
      text,
      references,
    });
    expect(
      store.getMessage(second.userMessage.id)?.parts[0],
    ).not.toHaveProperty("references");
  } finally {
    db.close();
  }
});

test("HTTP and internal runner reject illegal annotations before creating any run", () => {
  const invalid = {
    ...references,
    occurrences: [{ ...references.occurrences[0]!, end: 8 }],
  };
  expect(
    parseRunCreateRequestBody({
      ...body,
      input: { parts: [{ type: "text", text, references: invalid }] },
    }),
  ).toBeNull();
  for (const change of [
    { type: "unsupported" },
    { version: 9 },
    { data: { driver: "pg", password: "secret" } },
  ]) {
    expect(
      parseRunCreateRequestBody({
        ...body,
        input: {
          parts: [
            {
              type: "text",
              text,
              references: {
                ...references,
                targets: [{ ...target, ...change }],
              },
            },
          ],
        },
      }),
    ).toBeNull();
  }
  const db = openRuntimeDatabase(":memory:");
  try {
    const store = new RuntimeSqliteStore(db);
    const runner = new RuntimeRunner({ store, appVersion: "test" });
    expect(() =>
      runner.start({
        providerId: "test",
        modelId: "test",
        parts: [{ type: "text", text, references: invalid }],
      }),
    ).toThrow();
    expect(
      db.query("SELECT COUNT(*) AS n FROM runtime_conversations").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
