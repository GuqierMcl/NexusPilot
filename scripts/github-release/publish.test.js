import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectArtifacts,
  createMultipartUploadParts,
  publishRelease,
  putObjectMultipart,
  retryS3Operation,
  S3_MULTIPART_PART_SIZE_BYTES,
  S3_UPLOAD_MAX_ATTEMPTS,
  uploadObject,
  verifyUploadedObject,
} from "./publish.mjs";

const fixtures = {
  "nexpilot-linux-x86_64": [
    "NexusPilot-fixture_amd64.deb",
    "NexusPilot-fixture_amd64.deb.sig",
    "NexusPilot-fixture-1.x86_64.rpm",
    "NexusPilot-fixture-1.x86_64.rpm.sig",
  ],
  "nexpilot-windows-x86_64": [
    "NexusPilot-fixture_x64-setup.exe",
    "NexusPilot-fixture_x64-setup.exe.sig",
  ],
  "nexpilot-darwin-x86_64": [
    "NexusPilot-fixture_x64.dmg",
    "NexusPilot.app.tar.gz",
    "NexusPilot.app.tar.gz.sig",
  ],
  "nexpilot-darwin-aarch64": [
    "NexusPilot-fixture_aarch64.dmg",
    "NexusPilot.app.tar.gz",
    "NexusPilot.app.tar.gz.sig",
  ],
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseVersion = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;

function writeFixture(inputDir) {
  for (const [artifactDirectory, names] of Object.entries(fixtures)) {
    const bundleDir = path.join(inputDir, artifactDirectory, "src-tauri", "target", "release", "bundle");
    mkdirSync(bundleDir, { recursive: true });
    for (const name of names) {
      const filePath = path.join(bundleDir, name);
      writeFileSync(filePath, `${artifactDirectory}/${name}`);
    }
  }
}

describe("GitHub release artifact collection", () => {
  test("keeps Linux package updater payloads aligned with their installer type", () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-input-"));
    const outputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-output-"));
    writeFixture(inputDir);

    const { artifacts, updaterEntries } = collectArtifacts(inputDir, outputDir);
    const installers = artifacts.filter((artifact) => artifact.role === "installer");

    expect(installers).toHaveLength(5);
    expect(updaterEntries.map((entry) => entry.platform)).toEqual([
      "linux-x86_64-deb",
      "linux-x86_64-rpm",
      "windows-x86_64",
      "darwin-x86_64",
      "darwin-aarch64",
    ]);
    expect(artifacts.some((artifact) => artifact.platform === "linux-x86_64" && artifact.bundle === "deb" && artifact.role === "signature")).toBe(true);
    expect(artifacts.some((artifact) => artifact.platform === "linux-x86_64" && artifact.bundle === "rpm" && artifact.role === "signature")).toBe(true);
    expect(artifacts.some((artifact) => artifact.bundle === "appimage")).toBe(false);
    expect(artifacts.some((artifact) => artifact.platform === "windows-x86_64" && artifact.bundle === "nsis" && artifact.role === "signature")).toBe(true);
    expect(artifacts.some((artifact) => artifact.platform === "darwin-aarch64" && artifact.bundle === "macos" && artifact.role === "updater-signature")).toBe(true);
    expect(existsSync(path.join(outputDir, "windows-x86_64", "NexusPilot-fixture_x64-setup.exe"))).toBe(true);
  });

  test("creates package-specific Linux updater entries while exposing only requested installers", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-input-"));
    writeFixture(inputDir);

    Object.assign(process.env, {
      CI_RELEASE_PUBLIC_BASE_URL: "https://downloads.example.test/releases",
      CI_RELEASE_S3_ENDPOINT: "https://s3.example.test",
      CI_RELEASE_S3_BUCKET: "nexpilot",
      CI_RELEASE_S3_PREFIX: "releases",
      CI_RELEASE_S3_ACCESS_KEY_ID: "test-key",
      CI_RELEASE_S3_SECRET_ACCESS_KEY: "test-secret",
    });

    const result = await publishRelease({ version: releaseVersion, inputDir, dryRun: true });
    const current = result.publicIndex.versions[0];

    expect(Object.keys(result.latestJson.platforms)).toEqual([
      "linux-x86_64-deb",
      "linux-x86_64-rpm",
      "windows-x86_64",
      "darwin-x86_64",
      "darwin-aarch64",
    ]);
    expect(current?.downloads).toHaveLength(5);
    expect(current?.downloads.some((download) => download.bundle === "appimage")).toBe(false);
    expect(current?.downloads.some((download) => download.platform === "linux-x86_64" && download.bundle === "rpm")).toBe(true);
    expect(result.latestJson.platforms["linux-x86_64"]).toBeUndefined();
    expect(result.latestJson.platforms["linux-x86_64-deb"]?.url).toEndWith(".deb");
    expect(result.latestJson.platforms["linux-x86_64-rpm"]?.url).toEndWith(".rpm");
    expect(result.latestJson.platforms["windows-x86_64"]?.url).toEndWith("-setup.exe");
  });
});

describe("GitHub release S3 multipart upload", () => {
  test("splits large objects into fixed-size parts", () => {
    expect(createMultipartUploadParts(S3_MULTIPART_PART_SIZE_BYTES * 2 + 3)).toEqual([
      { partNumber: 1, start: 0, size: S3_MULTIPART_PART_SIZE_BYTES },
      { partNumber: 2, start: S3_MULTIPART_PART_SIZE_BYTES, size: S3_MULTIPART_PART_SIZE_BYTES },
      { partNumber: 3, start: S3_MULTIPART_PART_SIZE_BYTES * 2, size: 3 },
    ]);
  });

  test("uploads parts and completes the multipart object", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-multipart-"));
    const filePath = path.join(inputDir, "large-fixture.bin");
    writeFileSync(filePath, "abcdefghij");
    const calls = [];

    class FakeAbortMultipartUploadCommand {
      constructor(input) { this.input = input; }
    }
    class FakeCompleteMultipartUploadCommand {
      constructor(input) { this.input = input; }
    }
    class FakeCreateMultipartUploadCommand {
      constructor(input) { this.input = input; }
    }
    class FakeUploadPartCommand {
      constructor(input) { this.input = input; }
    }

    const client = {
      async send(command) {
        calls.push(command);
        if (command instanceof FakeCreateMultipartUploadCommand) return { UploadId: "upload-1" };
        if (command instanceof FakeUploadPartCommand) return { ETag: `etag-${command.input.PartNumber}` };
        return {};
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
      bucket: "nexpilot",
      key: "releases/v0.10.0/large-fixture.bin",
      filePath,
      totalBytes: 10,
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
      partSize: 4,
    });

    expect(calls).toHaveLength(5);
    expect(calls[1].input.Body.toString()).toBe("abcd");
    expect(calls[2].input.Body.toString()).toBe("efgh");
    expect(calls[3].input.Body.toString()).toBe("ij");
    expect(calls[4].input.MultipartUpload.Parts).toEqual([
      { ETag: "etag-1", PartNumber: 1 },
      { ETag: "etag-2", PartNumber: 2 },
      { ETag: "etag-3", PartNumber: 3 },
    ]);
  });

  test("aborts an incomplete multipart upload", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-multipart-"));
    const filePath = path.join(inputDir, "large-fixture.bin");
    writeFileSync(filePath, "abcdefghij");
    const calls = [];

    class FakeAbortMultipartUploadCommand {
      constructor(input) { this.input = input; }
    }
    class FakeCompleteMultipartUploadCommand {
      constructor(input) { this.input = input; }
    }
    class FakeCreateMultipartUploadCommand {
      constructor(input) { this.input = input; }
    }
    class FakeUploadPartCommand {
      constructor(input) { this.input = input; }
    }

    const client = {
      async send(command) {
        calls.push(command);
        if (command instanceof FakeCreateMultipartUploadCommand) return { UploadId: "upload-1" };
        if (command instanceof FakeUploadPartCommand) throw new Error("part failed");
        return {};
      },
    };

    await expect(putObjectMultipart({
      client,
      commands: {
        AbortMultipartUploadCommand: FakeAbortMultipartUploadCommand,
        CompleteMultipartUploadCommand: FakeCompleteMultipartUploadCommand,
        CreateMultipartUploadCommand: FakeCreateMultipartUploadCommand,
        UploadPartCommand: FakeUploadPartCommand,
      },
      bucket: "nexpilot",
      key: "releases/v0.10.0/large-fixture.bin",
      filePath,
      totalBytes: 10,
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
      partSize: 4,
    })).rejects.toThrow("part failed");

    expect(calls.at(-1)).toBeInstanceOf(FakeAbortMultipartUploadCommand);
  });

  test("falls back to buffered PutObject when multipart is unavailable", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-multipart-"));
    const filePath = path.join(inputDir, "large-fixture.bin");
    writeFileSync(filePath, Buffer.alloc(S3_MULTIPART_PART_SIZE_BYTES + 1, 7));

    class FakePutObjectCommand {
      constructor(input) { this.input = input; }
    }

    const calls = [];
    const warnings = [];
    const client = {
      async send(command) {
        calls.push(command);
        return {};
      },
    };

    await uploadObject({
      client,
      commands: { PutObjectCommand: FakePutObjectCommand },
      bucket: "nexpilot",
      key: "releases/v0.10.0/large-fixture.bin",
      filePath,
      cacheControl: "public, max-age=31536000, immutable",
      multipartUploader: async () => {
        throw new Error("multipart unsupported");
      },
      warn: (message) => warnings.push(message),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(FakePutObjectCommand);
    expect(calls[0].input.ContentLength).toBe(S3_MULTIPART_PART_SIZE_BYTES + 1);
    expect(calls[0].input.Body.length).toBe(S3_MULTIPART_PART_SIZE_BYTES + 1);
    expect(warnings[0]).toContain("回退到带 ContentLength 的 PutObject");
  });

  test("verifies an object through ListObjectsV2 when HeadObject returns 403", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-ci-multipart-"));
    const filePath = path.join(inputDir, "large-fixture.bin");
    writeFileSync(filePath, "abcdefghij");

    class FakeHeadObjectCommand {
      constructor(input) { this.input = input; }
    }
    class FakeListObjectsV2Command {
      constructor(input) { this.input = input; }
    }

    const client = {
      async send(command) {
        if (command instanceof FakeHeadObjectCommand) {
          const error = new Error("head forbidden for multipart object");
          error.$metadata = { httpStatusCode: 403 };
          throw error;
        }
        return { Contents: [{ Key: command.input.Prefix, Size: 10 }] };
      },
    };

    await verifyUploadedObject({
      client,
      commands: {
        HeadObjectCommand: FakeHeadObjectCommand,
        ListObjectsV2Command: FakeListObjectsV2Command,
      },
      bucket: "nexpilot",
      key: "releases/v0.10.0/large-fixture.bin",
      filePath,
    });
  });
});

describe("GitHub release S3 retry", () => {
  test("retries transient S3 failures with bounded backoff", async () => {
    let attempts = 0;
    const delays = [];
    const warnings = [];

    const result = await retryS3Operation(() => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("temporary object storage failure");
        error.$metadata = { httpStatusCode: 503 };
        throw error;
      }
      return "uploaded";
    }, {
      description: "上传测试对象",
      random: () => 0.5,
      sleepFor: async (delayMs) => delays.push(delayMs),
      warn: (message) => warnings.push(message),
    });

    expect(result).toBe("uploaded");
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1000]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("第 2/4 次");
  });

  test("does not retry authentication and authorization failures", async () => {
    let attempts = 0;
    const error = new Error("access denied");
    error.$metadata = { httpStatusCode: 403 };

    await expect(retryS3Operation(() => {
      attempts += 1;
      throw error;
    }, {
      sleepFor: async () => {
        throw new Error("non-retryable failure must not wait");
      },
    })).rejects.toBe(error);

    expect(attempts).toBe(1);
  });

  test("stops after the configured retry budget", async () => {
    let attempts = 0;
    const error = new Error("throttled");
    error.name = "ThrottlingException";

    await expect(retryS3Operation(() => {
      attempts += 1;
      throw error;
    }, {
      sleepFor: async () => {},
      warn: () => {},
    })).rejects.toBe(error);

    expect(attempts).toBe(S3_UPLOAD_MAX_ATTEMPTS);
  });
});
