import { describe, expect, test } from "bun:test";

import bodySource from "./data-table-body.tsx?raw";
import headerSource from "./data-table-header.tsx?raw";
import tableSource from "./data-table.tsx?raw";

describe("DataTable column virtualization", () => {
  test("keeps fixed-column virtualizer state inside the body", () => {
    expect(tableSource.includes("useFixedColumnVirtualizer")).toBe(false);
    expect(bodySource.includes("columnVirtualizer")).toBe(true);
    expect(bodySource.includes("useFixedColumnVirtualizer")).toBe(true);
  });

  test("keeps the header outside column virtualization during horizontal scroll", () => {
    expect(headerSource.includes("columnVirtualizer")).toBe(false);
    expect(headerSource.includes("getScrollableVirtualItems")).toBe(false);
  });

  test("does not render every visible cell when column virtualization is active", () => {
    expect(bodySource.includes("row.getVisibleCells().map")).toBe(false);
    expect(
      bodySource.includes("columnVirtualizer.getScrollableVirtualItems().map"),
    ).toBe(true);
  });
});
