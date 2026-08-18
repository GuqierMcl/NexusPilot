import { describe, expect, test } from "bun:test";

import {
  getMaskedConfigSummary,
  hasReleaseConfigValue,
  maskSecret,
  parseEnvContent,
  resolveReleaseConfig,
} from "./env.mjs";

describe("release env helpers", () => {
  test("parses dotenv content with comments, quotes, and inline comments", () => {
    const env = parseEnvContent(`
# Release configuration
RELEASE_S3_ENDPOINT=http://127.0.0.1:9000
RELEASE_S3_BUCKET="nexuspilot"
RELEASE_PUBLIC_BASE_URL='https://dl.nexuspilot.dev/oss/releases'
RELEASE_S3_FORCE_PATH_STYLE=true # MinIO needs path-style URLs
EMPTY_VALUE=
`);

    expect(env).toEqual({
      RELEASE_S3_ENDPOINT: "http://127.0.0.1:9000",
      RELEASE_S3_BUCKET: "nexuspilot",
      RELEASE_PUBLIC_BASE_URL: "https://dl.nexuspilot.dev/oss/releases",
      RELEASE_S3_FORCE_PATH_STYLE: "true",
      EMPTY_VALUE: "",
    });
  });

  test("masks secrets without leaking full values", () => {
    expect(maskSecret("abcdef123456")).toBe("abc***456");
    expect(maskSecret("short")).toBe("***");
    expect(maskSecret("")).toBe("");
  });

  test("resolves release config defaults for MinIO-compatible storage", () => {
    const config = resolveReleaseConfig({
      RELEASE_PUBLIC_BASE_URL: "https://dl.nexuspilot.dev/oss/releases/",
      RELEASE_S3_ENDPOINT: "http://127.0.0.1:9000",
      RELEASE_S3_BUCKET: "nexuspilot",
      RELEASE_S3_ACCESS_KEY_ID: "access",
      RELEASE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(config.outputDir).toBe("releases");
    expect(config.publicBaseUrl).toBe("https://dl.nexuspilot.dev/oss/releases");
    expect(config.s3.prefix).toBe("oss/releases");
    expect(config.s3.region).toBe("us-east-1");
    expect(config.s3.forcePathStyle).toBe(true);
    expect(config.updater.platform).toBe("windows-x86_64");
    expect(config.updater.artifact).toBe("nsis");
  });

  test("summarizes missing config values explicitly", () => {
    const summary = getMaskedConfigSummary(resolveReleaseConfig({}));

    expect(summary.s3.endpoint).toBe("<缺失>");
    expect(summary.s3.bucket).toBe("<缺失>");
    expect(summary.s3.accessKeyId).toBe("<缺失>");
    expect(summary.s3.secretAccessKey).toBe("<缺失>");
  });

  test("treats template placeholders as unconfigured values", () => {
    expect(hasReleaseConfigValue("real-value")).toBe(true);
    expect(hasReleaseConfigValue("change-me")).toBe(false);
    expect(hasReleaseConfigValue("C:\\Users\\YourName\\.tauri\\nexuspilot.key")).toBe(false);
    expect(hasReleaseConfigValue("")).toBe(false);
    expect(hasReleaseConfigValue(undefined)).toBe(false);
  });
});
