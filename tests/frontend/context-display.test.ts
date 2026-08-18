import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { formatContextUsagePercent } from "../../src/components/assistant-ui/context-display";

const contextDisplayPath = join(
  import.meta.dir,
  "../../src/components/assistant-ui/context-display.tsx",
);
const tooltipPath = join(import.meta.dir, "../../src/components/ui/tooltip.tsx");

describe("context display percent formatting", () => {
  test("shows nonzero usage below one percent instead of rounding it to zero", () => {
    expect(formatContextUsagePercent(0)).toBe("0%");
    expect(formatContextUsagePercent(0.48)).toBe("<1%");
    expect(formatContextUsagePercent(1.2)).toBe("1%");
  });

  test("disables the tooltip arrow through the Tooltip API", async () => {
    const [contextDisplaySource, tooltipSource] = await Promise.all([
      Bun.file(contextDisplayPath).text(),
      Bun.file(tooltipPath).text(),
    ]);

    expect(contextDisplaySource).toContain("hideArrow");
    expect(tooltipSource).toContain("hideArrow?: boolean");
    expect(tooltipSource).toContain("!hideArrow ?");
  });
});
