import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { toDataTableColumns } from "../../src/components/data-table/relational-data-table";
import type { ColumnMeta } from "../../src/types/ipc";

function readonlyColumn(
    name: string,
    typeName: string,
    dataCategory: ColumnMeta["dataCategory"],
): ColumnMeta {
    return {
        name,
        typeName,
        nullable: false,
        dataCategory,
        isPrimaryKey: false,
        isUnique: false,
        isWritable: false,
    };
}

test("relational table registers structured cells generically", () => {
    const [column] = toDataTableColumns(
        [readonlyColumn("attrs", "Map(UInt64, String)", "structured")],
        180,
    );
    expect(column?.cell).toBeFunction();
    const html = renderToStaticMarkup(
        <>{column?.cell?.([[1, "one"]], 0)}</>,
    );

    expect(html).toContain("结构化值");
    expect(html).not.toContain("[object Object]");
    expect(html.toLowerCase()).not.toContain("clickhouse");
});
