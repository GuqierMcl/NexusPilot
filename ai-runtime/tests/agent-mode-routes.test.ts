import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

async function appWithoutRuntimeStore() {
  return createApp(
    {
      host: "127.0.0.1",
      port: 8787,
      dataDir: "",
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    },
  );
}

describe("agent mode routes", () => {
  test("lists built-in agent modes as public UI catalog", async () => {
    const app = await appWithoutRuntimeStore();
    const response = await app.handle(new Request("http://localhost/v1/agent-modes"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        agent_mode: "ask",
        title: "Ask",
        built_in: true,
      }),
      expect.objectContaining({
        agent_mode: "query",
        title: "Query",
        built_in: true,
      }),
      expect.objectContaining({
        agent_mode: "agent",
        title: "Agent",
        built_in: true,
      }),
    ]);
    expect(body.data[0]).toHaveProperty("description");
    expect(body.data[0]).toHaveProperty("capabilities");
    expect(body.data[0]).not.toHaveProperty("system_prompt");
    expect(body.data[0]).not.toHaveProperty("limits");
    expect(body.data[0]).not.toHaveProperty("tool_policy");
  });
});
