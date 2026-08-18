import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cacheControlForUpload,
  createMultipartUploadParts,
  createReleaseConfigChecks,
  DEFAULT_MULTIPART_PART_SIZE,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  formatUploadBytes,
  formatUploadPercent,
  formatUploadProgressLine,
  makeObjectKey,
  putObjectMultipart,
} from "./commands.mjs";
import { resolveReleaseConfig } from "./env.mjs";

describe("release command checks", () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { force: true, recursive: true });
    }
  });

  test("creates nested S3 object keys for versioned release artifacts", () => {
    expect(makeObjectKey("releases", "v0.3.2", "windows-x86_64/NexusPilot_0.3.2_x64-setup.exe")).toBe(
      "releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
    );
  });

  test("formats upload progress with readable byte units", () => {
    expect(formatUploadBytes(0)).toBe("0 B");
    expect(formatUploadBytes(512)).toBe("512 B");
    expect(formatUploadBytes(1024)).toBe("1.0 KB");
    expect(formatUploadBytes(1536)).toBe("1.5 KB");
    expect(formatUploadBytes(1048576)).toBe("1.0 MB");
  });

  test("formats upload percentage safely", () => {
    expect(formatUploadPercent(0, 0)).toBe("100.0%");
    expect(formatUploadPercent(25, 100)).toBe("25.0%");
    expect(formatUploadPercent(100, 100)).toBe("100.0%");
    expect(formatUploadPercent(125, 100)).toBe("100.0%");
  });

  test("formats one upload progress line with the destination key", () => {
    expect(formatUploadProgressLine({
      label: "上传",
      filePath: "releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
      bucket: "nexuspilot",
      key: "oss/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
      uploadedBytes: 524288,
      totalBytes: 1048576,
    })).toBe(
      "上传 releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe -> s3://nexuspilot/oss/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe  50.0%  512.0 KB / 1.0 MB",
    );
  });

  test("uses no-cache for mutable release indices and immutable cache for versioned artifacts", () => {
    expect(cacheControlForUpload({ mutable: true })).toBe("no-cache");
    expect(cacheControlForUpload({ mutable: false })).toBe("public, max-age=31536000, immutable");
  });

  test("plans large uploads as S3 multipart parts", () => {
    const totalBytes = DEFAULT_MULTIPART_THRESHOLD_BYTES + 3;

    expect(createMultipartUploadParts(totalBytes)).toEqual([
      {
        partNumber: 1,
        start: 0,
        size: DEFAULT_MULTIPART_PART_SIZE,
      },
      {
        partNumber: 2,
        start: DEFAULT_MULTIPART_PART_SIZE,
        size: 3,
      },
    ]);
  });

  test("uploads large artifacts with multipart commands and confirmed progress", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "nexuspilot-release-multipart-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "artifact.exe");
    writeFileSync(filePath, Buffer.alloc(DEFAULT_MULTIPART_THRESHOLD_BYTES + 3, 7));

    class FakeCreateMultipartUploadCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class FakeUploadPartCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class FakeCompleteMultipartUploadCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class FakeAbortMultipartUploadCommand {
      constructor(input) {
        this.input = input;
      }
    }

    const calls = [];
    const client = {
      async send(command) {
        calls.push(command);
        if (command instanceof FakeCreateMultipartUploadCommand) {
          return { UploadId: "upload-1" };
        }
        if (command instanceof FakeUploadPartCommand) {
          return { ETag: `etag-${command.input.PartNumber}` };
        }
        return {};
      },
    };
    const progress = [];
    const reporter = {
      update(uploadedBytes) {
        progress.push(uploadedBytes);
      },
      finish() {
        progress.push("done");
      },
    };

    await putObjectMultipart({
      client,
      commands: {
        AbortMultipartUploadCommand: FakeAbortMultipartUploadCommand,
        CompleteMultipartUploadCommand: FakeCompleteMultipartUploadCommand,
        CreateMultipartUploadCommand: FakeCreateMultipartUploadCommand,
        UploadPartCommand: FakeUploadPartCommand,
      },
      bucket: "nexus-pilot",
      key: "releases/v0.4.0/artifact.exe",
      filePath,
      totalBytes: DEFAULT_MULTIPART_THRESHOLD_BYTES + 3,
      upload: { mutable: false },
      reporter,
    });

    expect(calls.map((command) => command.constructor.name)).toEqual([
      "FakeCreateMultipartUploadCommand",
      "FakeUploadPartCommand",
      "FakeUploadPartCommand",
      "FakeCompleteMultipartUploadCommand",
    ]);
    expect(calls[1].input.Body.length).toBe(DEFAULT_MULTIPART_PART_SIZE);
    expect(calls[2].input.Body.length).toBe(3);
    expect(calls[3].input.MultipartUpload.Parts).toEqual([
      { ETag: "etag-1", PartNumber: 1 },
      { ETag: "etag-2", PartNumber: 2 },
    ]);
    expect(progress).toEqual([
      DEFAULT_MULTIPART_PART_SIZE,
      DEFAULT_MULTIPART_THRESHOLD_BYTES + 3,
      "done",
    ]);
  });

  test("still treats a missing signing private key as a blocking error", () => {
    const checks = createReleaseConfigChecks(resolveReleaseConfig({
      RELEASE_PUBLIC_BASE_URL: "https://dl.nexuspilot.dev/releases",
      RELEASE_S3_ENDPOINT: "http://127.0.0.1:9000",
      RELEASE_S3_BUCKET: "nexuspilot",
      RELEASE_S3_ACCESS_KEY_ID: "access",
      RELEASE_S3_SECRET_ACCESS_KEY: "secret",
    }));
    const privateKeyCheck = checks.find((check) => check.name === "TAURI_SIGNING_PRIVATE_KEY");

    expect(privateKeyCheck?.level).toBe("error");
  });
});
