import { useCallback, useLayoutEffect, useMemo, useState } from "react";

export interface FixedColumnMeasurement {
  id: string;
  size: number;
  isFrozen: boolean;
}

export interface FixedColumnVirtualItem {
  index: number;
  key: string;
  columnId: string;
  start: number;
  size: number;
  isFrozen: boolean;
  frozenStart?: number;
  scrollableOrdinal?: number;
}

export interface FixedColumnVirtualRange {
  startOrdinal: number;
  endOrdinal: number;
}

export interface FixedColumnVirtualItems {
  frozenItems: FixedColumnVirtualItem[];
  scrollableItems: FixedColumnVirtualItem[];
  frozenSize: number;
  totalSize: number;
}

export interface FixedColumnVirtualizer {
  getTotalSize: () => number;
  getFrozenSize: () => number;
  getFrozenVirtualItems: () => FixedColumnVirtualItem[];
  getScrollableVirtualItems: () => FixedColumnVirtualItem[];
}

interface FixedColumnVirtualRangeInput {
  columns: FixedColumnMeasurement[];
  rowNumberWidth: number;
  viewportWidth: number;
  scrollLeft: number;
  overscan: number;
}

interface FixedColumnVirtualItemsInput extends FixedColumnVirtualRangeInput {
  range?: FixedColumnVirtualRange;
}

interface FixedColumnVirtualizerOptions {
  columns: FixedColumnMeasurement[];
  getScrollElement: () => HTMLDivElement | null;
  rowNumberWidth: number;
  overscan: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeSize(size: number): number {
  return Math.max(0, Number.isFinite(size) ? size : 0);
}

function normalizeRowNumberWidth(rowNumberWidth: number): number {
  return Math.max(0, Number.isFinite(rowNumberWidth) ? rowNumberWidth : 0);
}

function buildColumnLayout(
  columns: FixedColumnMeasurement[],
  rowNumberWidth: number,
): FixedColumnVirtualItems {
  const safeRowNumberWidth = normalizeRowNumberWidth(rowNumberWidth);
  const frozenItems: FixedColumnVirtualItem[] = [];
  const scrollableItems: FixedColumnVirtualItem[] = [];
  let start = safeRowNumberWidth;
  let frozenStart = safeRowNumberWidth;

  columns.forEach((column, index) => {
    const size = normalizeSize(column.size);
    const item: FixedColumnVirtualItem = {
      index,
      key: column.id,
      columnId: column.id,
      start,
      size,
      isFrozen: column.isFrozen,
    };

    if (column.isFrozen) {
      item.frozenStart = frozenStart;
      frozenItems.push(item);
      frozenStart += size;
    } else {
      item.scrollableOrdinal = scrollableItems.length;
      scrollableItems.push(item);
    }

    start += size;
  });

  return {
    frozenItems,
    scrollableItems,
    frozenSize: frozenStart - safeRowNumberWidth,
    totalSize: start,
  };
}

export function getFixedColumnVirtualRange({
  columns,
  rowNumberWidth,
  viewportWidth,
  scrollLeft,
  overscan,
}: FixedColumnVirtualRangeInput): FixedColumnVirtualRange {
  const layout = buildColumnLayout(columns, rowNumberWidth);
  const scrollableItems = layout.scrollableItems;

  if (scrollableItems.length === 0) {
    return { startOrdinal: 0, endOrdinal: -1 };
  }

  const lastOrdinal = scrollableItems.length - 1;
  const safeScrollLeft = Math.max(0, scrollLeft);
  const safeViewportWidth = Math.max(0, viewportWidth);
  const safeOverscan = Math.max(0, Math.floor(overscan));

  if (safeViewportWidth === 0) {
    return { startOrdinal: 0, endOrdinal: lastOrdinal };
  }

  const viewportStart = safeScrollLeft;
  const viewportEnd = safeScrollLeft + safeViewportWidth;
  let firstVisible = -1;
  let lastVisible = -1;

  for (const item of scrollableItems) {
    const itemStart = item.start;
    const itemEnd = item.start + item.size;
    const intersects = itemStart < viewportEnd && itemEnd > viewportStart;

    if (!intersects) continue;

    const ordinal = item.scrollableOrdinal ?? 0;
    if (firstVisible === -1) firstVisible = ordinal;
    lastVisible = ordinal;
  }

  if (firstVisible === -1) {
    const beforeFirst = viewportStart < scrollableItems[0]!.start;
    const fallbackOrdinal = beforeFirst ? 0 : lastOrdinal;
    firstVisible = fallbackOrdinal;
    lastVisible = fallbackOrdinal;
  }

  return {
    startOrdinal: clamp(firstVisible - safeOverscan, 0, lastOrdinal),
    endOrdinal: clamp(lastVisible + safeOverscan, 0, lastOrdinal),
  };
}

export function buildFixedColumnVirtualItems({
  columns,
  rowNumberWidth,
  viewportWidth,
  scrollLeft,
  overscan,
  range,
}: FixedColumnVirtualItemsInput): FixedColumnVirtualItems {
  const layout = buildColumnLayout(columns, rowNumberWidth);
  const resolvedRange =
    range ??
    getFixedColumnVirtualRange({
      columns,
      rowNumberWidth,
      viewportWidth,
      scrollLeft,
      overscan,
    });
  const lastOrdinal = layout.scrollableItems.length - 1;
  const startOrdinal =
    lastOrdinal < 0 ? 0 : clamp(resolvedRange.startOrdinal, 0, lastOrdinal);
  const endOrdinal =
    lastOrdinal < 0
      ? -1
      : clamp(Math.max(resolvedRange.endOrdinal, startOrdinal), 0, lastOrdinal);

  return {
    frozenItems: layout.frozenItems,
    scrollableItems:
      endOrdinal < startOrdinal
        ? []
        : layout.scrollableItems.slice(startOrdinal, endOrdinal + 1),
    frozenSize: layout.frozenSize,
    totalSize: layout.totalSize,
  };
}

export function useFixedColumnVirtualizer({
  columns,
  getScrollElement,
  rowNumberWidth,
  overscan,
}: FixedColumnVirtualizerOptions): FixedColumnVirtualizer {
  const [rangeState, setRangeState] = useState(() =>
    getFixedColumnVirtualRange({
      columns,
      rowNumberWidth,
      viewportWidth: 0,
      scrollLeft: 0,
      overscan,
    }),
  );

  const syncRange = useCallback(() => {
    const scrollElement = getScrollElement();
    const nextRange = getFixedColumnVirtualRange({
      columns,
      rowNumberWidth,
      viewportWidth: scrollElement?.clientWidth ?? 0,
      scrollLeft: scrollElement?.scrollLeft ?? 0,
      overscan,
    });

    setRangeState((current) =>
      current.startOrdinal === nextRange.startOrdinal &&
      current.endOrdinal === nextRange.endOrdinal
        ? current
        : nextRange,
    );
  }, [columns, getScrollElement, overscan, rowNumberWidth]);

  useLayoutEffect(() => {
    let frameId: number | null = null;
    let cleanupScrollElement: (() => void) | null = null;

    const attachScrollElement = () => {
      const scrollElement = getScrollElement();
      syncRange();

      if (!scrollElement) {
        frameId = requestAnimationFrame(attachScrollElement);
        return;
      }

      scrollElement.addEventListener("scroll", syncRange, { passive: true });

      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(syncRange);
      resizeObserver?.observe(scrollElement);
      frameId = requestAnimationFrame(syncRange);

      cleanupScrollElement = () => {
        scrollElement.removeEventListener("scroll", syncRange);
        resizeObserver?.disconnect();
      };
    };

    attachScrollElement();

    return () => {
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
      cleanupScrollElement?.();
    };
  }, [getScrollElement, syncRange]);

  const virtualItems = useMemo(
    () =>
      buildFixedColumnVirtualItems({
        columns,
        rowNumberWidth,
        viewportWidth: 0,
        scrollLeft: 0,
        overscan,
        range: rangeState,
      }),
    [columns, overscan, rangeState, rowNumberWidth],
  );

  const getTotalSize = useCallback(
    () => virtualItems.totalSize,
    [virtualItems.totalSize],
  );
  const getFrozenSize = useCallback(
    () => virtualItems.frozenSize,
    [virtualItems.frozenSize],
  );
  const getFrozenVirtualItems = useCallback(
    () => virtualItems.frozenItems,
    [virtualItems.frozenItems],
  );
  const getScrollableVirtualItems = useCallback(
    () => virtualItems.scrollableItems,
    [virtualItems.scrollableItems],
  );

  return useMemo(
    () => ({
      getTotalSize,
      getFrozenSize,
      getFrozenVirtualItems,
      getScrollableVirtualItems,
    }),
    [
      getFrozenSize,
      getFrozenVirtualItems,
      getScrollableVirtualItems,
      getTotalSize,
    ],
  );
}
