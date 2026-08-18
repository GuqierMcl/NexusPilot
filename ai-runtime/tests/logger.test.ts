import { describe, expect, test } from "bun:test";
import { createRuntimeLogger } from "../src/core/logger";

describe("runtime logger", () => {
  test("formats pretty logs with colored levels and readable metadata", () => {
    const lines: string[] = [];
    const logger = createRuntimeLogger({
      color: true,
      format: "pretty",
      level: "info",
      write: (line) => lines.push(line),
    });

    logger.info({ requestId: "req_123", route: "/health" }, "runtime ready");

    const output = lines.join("");
    expect(output).toContain("\u001b[32mINFO\u001b[0m");
    expect(output).toContain("runtime ready");
    expect(output).toContain("requestId=req_123");
    expect(output).toContain("route=/health");
  });

  test("keeps JSON logs structured and redacts sensitive fields", () => {
    const lines: string[] = [];
    const logger = createRuntimeLogger({
      format: "json",
      level: "info",
      write: (line) => lines.push(line),
    });

    logger.info(
      {
        apiKey: "sk-secret",
        headers: { authorization: "Bearer secret" },
        connection: { password: "db-secret" },
      },
      "provider configured",
    );

    const payload = JSON.parse(lines.join("")) as {
      apiKey: string;
      headers: { authorization: string };
      connection: { password: string };
      msg: string;
    };

    expect(payload.msg).toBe("provider configured");
    expect(payload.apiKey).toBe("[REDACTED]");
    expect(payload.headers.authorization).toBe("[REDACTED]");
    expect(payload.connection.password).toBe("[REDACTED]");
  });
});
