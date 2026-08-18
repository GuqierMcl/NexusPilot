import { describe, expect, test } from "bun:test";
import {
  colorizeBanner,
  NEXUS_AI_RUNTIME_BANNER,
  printStartupBanner,
} from "../src/banner";

describe("startup banner", () => {
  test("keeps the Nexus AI Runtime banner text", () => {
    expect(NEXUS_AI_RUNTIME_BANNER).toContain("███╗   ██╗███████╗");
    expect(NEXUS_AI_RUNTIME_BANNER).toContain("█████╗ ██╗    ██████╗ ██╗   ██╗");
  });

  test("prints the startup banner", () => {
    const lines: string[] = [];

    printStartupBanner((text) => lines.push(text));

    expect(lines).toEqual([NEXUS_AI_RUNTIME_BANNER]);
  });

  test("prints a colored startup banner when color is enabled", () => {
    const lines: string[] = [];

    printStartupBanner((text) => lines.push(text), { color: true });

    expect(lines).toEqual([colorizeBanner(NEXUS_AI_RUNTIME_BANNER)]);
    expect(lines[0]).toContain("\u001b[");
    expect(lines[0]).toContain("███╗   ██╗███████╗");
  });
});
