import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RawSqlResultView } from "../../../../src/features/workbench/content/components/sql-editor/RawSqlResultView";

test("Raw result view renders bounded metadata and preview without ownership internals", () => {
    const html = renderToStaticMarkup(
        <RawSqlResultView
            outcome={{
                kind: "raw",
                format: "Parquet",
                mediaType: "application/vnd.apache.parquet",
                byteLength: "9007199254740993",
                preview: "[hex] 50 41 52 31",
                previewTruncated: true,
                artifactId: "artifact-1",
            }}
            isSaving={false}
            onSave={() => undefined}
        />,
    );

    expect(html).toContain("Parquet");
    expect(html).toContain("application/vnd.apache.parquet");
    expect(html).toContain("9,007,199,254,740,993");
    expect(html).toContain("[hex] 50 41 52 31");
    expect(html).toContain("Hex 预览");
    expect(html).toContain("预览已截断");
    expect(html).toContain("另存为");
    for (const forbidden of [
        "artifact-1",
        "tempPath",
        "destinationPath",
        "SELECT",
    ]) {
        expect(html).not.toContain(forbidden);
    }
});
