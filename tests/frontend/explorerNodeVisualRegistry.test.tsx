import { expect, test } from "bun:test";
import {
    BookOpen,
    Database,
    Eye,
    Folder,
    FolderOpen,
    KeyRound,
    PanelTop,
    ScanEye,
    Table,
    Table2,
} from "lucide-react";

import {
    getAssetGroupVisual,
    getExplorerNodeVisual,
} from "../../src/features/workbench/explorer/components/explorer-node-visual-registry";

test("node visual registry preserves local and remote node icons", () => {
    expect(getExplorerNodeVisual("group", false).icon).toBe(Folder);
    expect(getExplorerNodeVisual("group", true).icon).toBe(FolderOpen);
    expect(getExplorerNodeVisual("database", false).icon).toBe(Database);
    expect(getExplorerNodeVisual("table", false).icon).toBe(Table);
    expect(getExplorerNodeVisual("view", false).icon).toBe(ScanEye);
    expect(getExplorerNodeVisual("materialized_view", false).icon).toBe(Eye);
    expect(getExplorerNodeVisual("redis_key", false).icon).toBe(KeyRound);
    expect(getExplorerNodeVisual("dictionary", false).icon).toBe(BookOpen);
    expect(getExplorerNodeVisual("projection", false).icon).toBe(PanelTop);
});

test("asset group visual registry preserves group-specific icons", () => {
    expect(getAssetGroupVisual("tables", false).icon).toBe(Table2);
    expect(getAssetGroupVisual("views", false).icon).toBe(Eye);
    expect(getAssetGroupVisual("dictionaries", false).icon).toBe(BookOpen);
    expect(getAssetGroupVisual("projections", false).icon).toBe(PanelTop);
    expect(getAssetGroupVisual(undefined, false).icon).toBe(Folder);
    expect(getAssetGroupVisual(undefined, true).icon).toBe(FolderOpen);
});
