import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

async function startRuntime(accessToken: string | null) {
  const app = await createApp({
    host: "127.0.0.1",
    port: 8787,
    accessToken,
    dataDir: "",
    catalogPath: "",
    providersPath: "",
    runtimeDbPath: "",
  });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("test Runtime did not bind a port");
  return { app, port };
}

function openBridge(port: number, token?: string): Promise<{
  socket: WebSocket;
  firstFrame: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/internal/backend-bridge`,
      token ? ({ headers: { Authorization: `Bearer ${token}` } } as never) : undefined,
    );
    const timeout = setTimeout(() => reject(new Error("WebSocket test timed out")), 2_000);
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket upgrade rejected"));
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket upgrade rejected"));
    };
    socket.onmessage = (event) => {
      clearTimeout(timeout);
      resolve({
        socket,
        firstFrame: JSON.parse(String(event.data)) as Record<string, unknown>,
      });
    };
  });
}

describe("Backend Bridge WebSocket route", () => {
  test("rejects anonymous Upgrade and accepts the per-launch Bearer token", async () => {
    const { app, port } = await startRuntime("route-test-token");
    try {
      await expect(openBridge(port)).rejects.toThrow("WebSocket upgrade rejected");
      const { socket, firstFrame } = await openBridge(port, "route-test-token");
      expect(firstFrame.type).toBe("runtime.ready");
      socket.send(JSON.stringify({ type: "backend.ready" }));
      await Bun.sleep(25);

      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health.data.backendBridge.state).toBe("ready");
      socket.close();
    } finally {
      await app.stop(true);
    }
  });

  test("allows tokenless development Upgrade", async () => {
    const { app, port } = await startRuntime(null);
    try {
      const { socket, firstFrame } = await openBridge(port);
      expect(firstFrame.type).toBe("runtime.ready");
      socket.close();
    } finally {
      await app.stop(true);
    }
  });
});
