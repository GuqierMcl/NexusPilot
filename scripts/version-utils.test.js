import { describe, expect, test } from "bun:test";

import { computeNextVersion } from "./version-utils.js";

describe("computeNextVersion", () => {
  test("bumps stable versions", () => {
    expect(computeNextVersion("0.2.15", "patch")).toBe("0.2.16");
    expect(computeNextVersion("0.2.15", "minor")).toBe("0.3.0");
    expect(computeNextVersion("0.2.15", "major")).toBe("1.0.0");
  });

  test("creates and increments prerelease versions", () => {
    expect(computeNextVersion("0.2.15", "prerelease", "alpha")).toBe("0.2.16-alpha.0");
    expect(computeNextVersion("0.2.16-alpha.0", "prerelease", "alpha")).toBe("0.2.16-alpha.1");
    expect(computeNextVersion("0.2.16-alpha.1", "prerelease", "beta")).toBe("0.2.16-beta.0");
  });

  test("bumps pre-release bases", () => {
    expect(computeNextVersion("0.2.15", "prepatch", "rc")).toBe("0.2.16-rc.0");
    expect(computeNextVersion("0.2.15", "preminor", "beta")).toBe("0.3.0-beta.0");
    expect(computeNextVersion("0.2.15", "premajor", "alpha")).toBe("1.0.0-alpha.0");
  });

  test("rejects unsupported version formats", () => {
    expect(() => computeNextVersion("0.2", "patch")).toThrow("Unsupported package version format");
  });
});
