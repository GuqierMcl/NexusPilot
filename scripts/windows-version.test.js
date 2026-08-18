import { describe, expect, test } from "bun:test";

import { toWindowsVersion } from "./windows-version.js";

describe("toWindowsVersion", () => {
  test("maps stable versions to the highest fourth component", () => {
    expect(toWindowsVersion("0.8.1")).toBe("0.8.1.65535");
  });

  test("keeps alpha, beta, release-candidate, and stable builds ordered", () => {
    expect(toWindowsVersion("0.8.2-alpha.0")).toBe("0.8.2.0");
    expect(toWindowsVersion("0.8.2-alpha.1")).toBe("0.8.2.1");
    expect(toWindowsVersion("0.8.2-beta.0")).toBe("0.8.2.16384");
    expect(toWindowsVersion("0.8.2-rc.0")).toBe("0.8.2.32768");
    expect(toWindowsVersion("0.8.2")).toBe("0.8.2.65535");
  });

  test("rejects unsupported or overflowing SemVer values", () => {
    expect(() => toWindowsVersion("0.8.2-preview.0")).toThrow(
      "Unsupported AI Runtime version",
    );
    expect(() => toWindowsVersion("0.8.2-alpha.16384")).toThrow(
      "pre-release sequence must be below 16384",
    );
    expect(() => toWindowsVersion("0.8.70000")).toThrow(
      "patch component must be an integer between 0 and 65535",
    );
  });
});
