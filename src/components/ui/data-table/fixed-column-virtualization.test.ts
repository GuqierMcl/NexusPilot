import { describe, expect, test } from "bun:test";

import {
  buildFixedColumnVirtualItems,
  getFixedColumnVirtualRange,
} from "./fixed-column-virtualization";

const columns = [
  { id: "id", size: 80, isFrozen: false },
  { id: "name", size: 160, isFrozen: false },
  { id: "email", size: 220, isFrozen: false },
  { id: "status", size: 120, isFrozen: false },
  { id: "created_at", size: 180, isFrozen: false },
];

describe("fixed-column virtualization", () => {
  test("calculates a visible column range from horizontal scroll geometry", () => {
    const range = getFixedColumnVirtualRange({
      columns,
      rowNumberWidth: 48,
      viewportWidth: 260,
      scrollLeft: 208,
      overscan: 0,
    });

    expect(range).toEqual({ startOrdinal: 1, endOrdinal: 2 });
  });

  test("applies column overscan by non-frozen column ordinal", () => {
    const range = getFixedColumnVirtualRange({
      columns,
      rowNumberWidth: 48,
      viewportWidth: 260,
      scrollLeft: 208,
      overscan: 1,
    });

    expect(range).toEqual({ startOrdinal: 0, endOrdinal: 3 });
  });

  test("renders all scrollable columns while viewport width is unknown", () => {
    const range = getFixedColumnVirtualRange({
      columns,
      rowNumberWidth: 48,
      viewportWidth: 0,
      scrollLeft: 0,
      overscan: 2,
    });

    expect(range).toEqual({ startOrdinal: 0, endOrdinal: 4 });
  });

  test("keeps frozen columns outside the scrollable virtual range", () => {
    const items = buildFixedColumnVirtualItems({
      columns: [
        { id: "id", size: 80, isFrozen: true },
        { id: "name", size: 160, isFrozen: false },
        { id: "email", size: 220, isFrozen: false },
        { id: "status", size: 120, isFrozen: false },
      ],
      rowNumberWidth: 48,
      viewportWidth: 180,
      scrollLeft: 208,
      overscan: 0,
    });

    expect(items.frozenItems.map((item) => item.columnId)).toEqual(["id"]);
    expect(items.scrollableItems.map((item) => item.columnId)).toEqual([
      "name",
      "email",
    ]);
    expect(items.frozenItems[0]?.frozenStart).toBe(48);
    expect(items.scrollableItems[0]?.start).toBe(128);
  });

  test("clamps a stale range after the column set shrinks", () => {
    const items = buildFixedColumnVirtualItems({
      columns: columns.slice(0, 2),
      rowNumberWidth: 48,
      viewportWidth: 260,
      scrollLeft: 0,
      overscan: 0,
      range: { startOrdinal: 3, endOrdinal: 8 },
    });

    expect(items.scrollableItems.map((item) => item.columnId)).toEqual([
      "name",
    ]);
  });
});
