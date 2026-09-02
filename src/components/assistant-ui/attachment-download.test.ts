import { describe, expect, test } from "bun:test";

import { saveRuntimeAttachment } from "@/components/assistant-ui/attachment-download";

describe("saveRuntimeAttachment", () => {
  test("asks for a destination and writes the authenticated attachment there", async () => {
    const calls: string[] = [];
    const result = await saveRuntimeAttachment({
      attachmentId: "att_report",
      baseUrl: "http://127.0.0.1:8787/",
      accessToken: "launch-token",
      name: "quarterly-report.pdf",
      selectDestination: async (options) => {
        expect(options).toEqual({
          title: "保存附件",
          defaultPath: "quarterly-report.pdf",
        });
        calls.push("select");
        return "D:\\Exports\\quarterly-report.pdf";
      },
      request: (async (input, init) => {
        expect(input).toBe(
          "http://127.0.0.1:8787/v1/attachments/att_report/content",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer launch-token",
        );
        calls.push("request");
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as typeof fetch,
      persist: async (path, contents) => {
        expect(path).toBe("D:\\Exports\\quarterly-report.pdf");
        expect(Array.from(contents)).toEqual([1, 2, 3]);
        calls.push("persist");
      },
    });

    expect(result).toBe("saved");
    expect(calls).toEqual(["select", "request", "persist"]);
  });

  test("stops before downloading when the save dialog is cancelled", async () => {
    let requested = false;
    let persisted = false;
    const result = await saveRuntimeAttachment({
      attachmentId: "att_cancelled",
      baseUrl: "http://127.0.0.1:8787",
      accessToken: "launch-token",
      name: "cancelled.txt",
      selectDestination: async () => null,
      request: (async () => {
        requested = true;
        return new Response();
      }) as typeof fetch,
      persist: async () => {
        persisted = true;
      },
    });

    expect(result).toBe("cancelled");
    expect(requested).toBe(false);
    expect(persisted).toBe(false);
  });
});
