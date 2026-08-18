import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
    formatStructuredValue,
    StructuredValuePreview,
} from "../../src/components/data-table/structured-value-preview";

test("renders bounded structured summaries without driver knowledge", () => {
    const html = renderToStaticMarkup(
        <StructuredValuePreview
            value={[
                [1, "one"],
                [2, { nested: true }],
            ]}
        />,
    );

    expect(html).toContain("2 项");
    expect(html).toContain("查看结构化值");
    expect(html.toLowerCase()).not.toContain("clickhouse");
});

test("formats copy text safely within a bounded preview", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatStructuredValue(cyclic)).toBe("<不可序列化结构>");

    const long = formatStructuredValue({ value: "x".repeat(500) }, 120);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
});
