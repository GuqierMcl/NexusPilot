import { describe, expect, test } from "bun:test";

import {
  getMaskedConfigSummary,
  hasReleaseConfigValue,
  parseEnvContent,
  redactReleaseSecrets,
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

  test("summarizes configured secrets without exposing any credential characters", () => {
    const accessKeyId = "AKIAEXAMPLE1234567";
    const secretAccessKey = "release-super-secret";
    const privateKey = "TAURI_PRIVATE_KEY_MATERIAL";
    const privateKeyPassword = "signing-password";
    const summary = getMaskedConfigSummary(resolveReleaseConfig({
      RELEASE_S3_ACCESS_KEY_ID: accessKeyId,
      RELEASE_S3_SECRET_ACCESS_KEY: secretAccessKey,
      TAURI_SIGNING_PRIVATE_KEY: privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: privateKeyPassword,
    }));
    const serialized = JSON.stringify(summary);

    expect(summary.s3.accessKeyId).toBe("<已配置>");
    expect(summary.s3.secretAccessKey).toBe("<已配置>");
    expect(summary.signing.privateKey).toBe("<已配置>");
    expect(summary.signing.privateKeyPassword).toBe("<已配置>");
    for (const secret of [accessKeyId, secretAccessKey, privateKey, privateKeyPassword]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(`${secret.slice(0, 3)}***${secret.slice(-3)}`);
    }
  });

  test("redacts release credentials from top-level error messages", () => {
    const env = {
      RELEASE_S3_ACCESS_KEY_ID: "release-access-key",
      RELEASE_S3_SECRET_ACCESS_KEY: "release-secret-key",
      CI_RELEASE_S3_ACCESS_KEY_ID: "ci-access-key",
      CI_RELEASE_S3_SECRET_ACCESS_KEY: "ci-secret-key",
      TAURI_SIGNING_PRIVATE_KEY: "line-one\nline-two\nline-three",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "signing-password",
    };
    const message = Object.values(env).join(" | ");
    const redacted = redactReleaseSecrets(message, env);

    for (const secret of Object.values(env)) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toBe(Array(Object.keys(env).length).fill("<已脱敏>").join(" | "));
  });

  test("preserves non-sensitive error details and ignores unsafe short replacements", () => {
    const message = "S3 request failed with status 403";

    expect(redactReleaseSecrets(message, {
      RELEASE_S3_ACCESS_KEY_ID: "S3",
      RELEASE_S3_SECRET_ACCESS_KEY: "",
    })).toBe(message);
  });

  test("treats template placeholders as unconfigured values", () => {
    expect(hasReleaseConfigValue("real-value")).toBe(true);
    expect(hasReleaseConfigValue("change-me")).toBe(false);
    expect(hasReleaseConfigValue("C:\\Users\\YourName\\.tauri\\nexuspilot.key")).toBe(false);
    expect(hasReleaseConfigValue("")).toBe(false);
    expect(hasReleaseConfigValue(undefined)).toBe(false);
  });
});
