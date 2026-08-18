import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ExplorerNodeProperties } from "../../src/features/workbench/explorer/components/ExplorerNodeProperties";

test("renders generic labels and values without interpreting property keys", () => {
    const html = renderToStaticMarkup(
        <ExplorerNodeProperties
            properties={[
                { key: "engine", label: "引擎", value: "MergeTree" },
                { key: "owner", label: "所有者", value: "app" },
            ]}
        />,
    );

    expect(html).toContain("引擎");
    expect(html).toContain("MergeTree");
    expect(html).toContain("所有者: app");
});

test("renders nothing when properties are absent", () => {
    expect(renderToStaticMarkup(<ExplorerNodeProperties />)).toBe("");
});
