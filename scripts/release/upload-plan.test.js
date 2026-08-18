import { describe, expect, test } from "bun:test";
import path from "node:path";

import { createReleaseLayout } from "./artifacts.mjs";
import { createReleaseUploadPlan, makeObjectKey } from "./upload-plan.mjs";

const config = {
  s3: {
    bucket: "nexuspilot",
    prefix: "releases",
  },
};

describe("release upload plan", () => {
  test("creates nested S3 object keys", () => {
    expect(makeObjectKey("releases", "v0.3.2", "windows-x86_64/app.exe")).toBe(
      "releases/v0.3.2/windows-x86_64/app.exe",
    );
  });

  test("uploads version snapshot first, root index second, updater latest last", () => {
    const layout = createReleaseLayout("D:/repo", "releases", "0.3.2");
    const plan = createReleaseUploadPlan({
      layout,
      config,
      versionedFiles: [
        path.join(layout.rootDir, "index.json"),
        path.join(layout.rootDir, "latest.json"),
        path.join(layout.rootDir, "windows-x86_64", "app.exe"),
      ],
    });

    expect(plan.rootIndexUpload.key).toBe("releases/index.json");
    expect(plan.rootLatestUpload.key).toBe("releases/latest.json");
    expect(plan.allUploads.map((upload) => upload.key)).toEqual([
      "releases/v0.3.2/index.json",
      "releases/v0.3.2/latest.json",
      "releases/v0.3.2/windows-x86_64/app.exe",
      "releases/index.json",
      "releases/latest.json",
    ]);
    expect(plan.versionedUploads.every((upload) => upload.mutable)).toBe(false);
    expect(plan.rootIndexUpload.mutable).toBe(true);
    expect(plan.rootLatestUpload.mutable).toBe(true);
  });

  test("does not upload legacy generated manifests left in a version directory", () => {
    const layout = createReleaseLayout("D:/repo", "releases", "0.3.2");
    const plan = createReleaseUploadPlan({
      layout,
      config,
      versionedFiles: [
        path.join(layout.rootDir, "index.json"),
        path.join(layout.rootDir, "latest.json"),
        path.join(layout.rootDir, "public.json"),
        path.join(layout.rootDir, "release.json"),
      ],
    });

    expect(plan.versionedUploads.map((upload) => upload.key)).toEqual([
      "releases/v0.3.2/index.json",
      "releases/v0.3.2/latest.json",
    ]);
  });
});
