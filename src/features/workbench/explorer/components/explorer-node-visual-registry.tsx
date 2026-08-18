import type React from "react";
import {
    ArrowLeftRight,
    BookOpen,
    Box,
    Braces,
    CircleDot,
    Columns2,
    Database,
    Eye,
    FileJson,
    FileText,
    Folder,
    FolderOpen,
    FunctionSquare,
    Hash,
    KeyRound,
    Layers,
    ListTree,
    PanelTop,
    Puzzle,
    ScanEye,
    Search,
    Server,
    Sigma,
    Table,
    Table2,
    Timer,
    Workflow,
    Zap,
} from "lucide-react";

import type { ExplorerTreeNodeType } from "@/features/workbench/explorer/types";
import type { AssetGroupType } from "@/types/ipc";

export interface ExplorerNodeVisual {
    icon: React.ElementType<{ className?: string }>;
    className: string;
}

const REMOTE_FALLBACK_VISUAL: ExplorerNodeVisual = {
    icon: Database,
    className: "size-4 shrink-0 text-slate-400",
};

const CLOSED_FOLDER_VISUAL: ExplorerNodeVisual = {
    icon: Folder,
    className: "size-4 shrink-0 text-amber-500",
};

const OPEN_FOLDER_VISUAL: ExplorerNodeVisual = {
    icon: FolderOpen,
    className: "size-4 shrink-0 text-amber-500",
};

const CLOSED_ASSET_GROUP_VISUAL: ExplorerNodeVisual = {
    icon: Folder,
    className: "size-4 shrink-0 text-slate-500",
};

const OPEN_ASSET_GROUP_VISUAL: ExplorerNodeVisual = {
    icon: FolderOpen,
    className: "size-4 shrink-0 text-slate-500",
};

const NODE_VISUALS: Partial<Record<ExplorerTreeNodeType, ExplorerNodeVisual>> = {
    database: { icon: Database, className: "size-4 shrink-0 text-blue-500" },
    schema: { icon: Layers, className: "size-4 shrink-0 text-violet-500" },
    table: { icon: Table, className: "size-4 shrink-0 text-green-600" },
    view: { icon: ScanEye, className: "size-4 shrink-0 text-cyan-600" },
    materialized_view: { icon: Eye, className: "size-4 shrink-0 text-cyan-700" },
    function: { icon: Braces, className: "size-4 shrink-0 text-orange-500" },
    procedure: { icon: Workflow, className: "size-4 shrink-0 text-orange-500" },
    trigger: { icon: Zap, className: "size-4 shrink-0 text-yellow-500" },
    index: { icon: Hash, className: "size-4 shrink-0 text-sky-500" },
    dictionary: { icon: BookOpen, className: "size-4 shrink-0 text-fuchsia-500" },
    projection: { icon: PanelTop, className: "size-4 shrink-0 text-indigo-500" },
    sequence: { icon: ListTree, className: "size-4 shrink-0 text-indigo-500" },
    extension: { icon: Puzzle, className: "size-4 shrink-0 text-pink-500" },
    event: { icon: Timer, className: "size-4 shrink-0 text-yellow-600" },
    column: { icon: Columns2, className: "size-4 shrink-0 text-slate-400" },
    redis_database: { icon: Database, className: "size-4 shrink-0 text-red-500" },
    redis_key_prefix: { icon: KeyRound, className: "size-4 shrink-0 text-red-500" },
    redis_key: { icon: KeyRound, className: "size-4 shrink-0 text-red-500" },
    collection: { icon: Box, className: "size-4 shrink-0 text-purple-500" },
    document: { icon: FileJson, className: "size-4 shrink-0 text-purple-500" },
    field: { icon: Columns2, className: "size-4 shrink-0 text-slate-400" },
    mapping_field: { icon: Columns2, className: "size-4 shrink-0 text-slate-400" },
    vector_collection: { icon: Sigma, className: "size-4 shrink-0 text-purple-500" },
    partition: { icon: Server, className: "size-4 shrink-0 text-purple-500" },
    node_label: { icon: CircleDot, className: "size-4 shrink-0 text-teal-500" },
    relationship_type: {
        icon: ArrowLeftRight,
        className: "size-4 shrink-0 text-rose-500",
    },
    search_index: { icon: Search, className: "size-4 shrink-0 text-emerald-500" },
    data_stream: { icon: FileText, className: "size-4 shrink-0 text-emerald-500" },
};

const ASSET_GROUP_VISUALS: Partial<Record<AssetGroupType, ExplorerNodeVisual>> = {
    tables: { icon: Table2, className: "size-4 shrink-0 text-slate-500" },
    views: { icon: Eye, className: "size-4 shrink-0 text-slate-500" },
    materialized_views: { icon: Eye, className: "size-4 shrink-0 text-slate-500" },
    functions: { icon: FunctionSquare, className: "size-4 shrink-0 text-slate-500" },
    procedures: { icon: FunctionSquare, className: "size-4 shrink-0 text-slate-500" },
    columns: { icon: Columns2, className: "size-4 shrink-0 text-slate-500" },
    fields: { icon: Columns2, className: "size-4 shrink-0 text-slate-500" },
    mappings: { icon: Columns2, className: "size-4 shrink-0 text-slate-500" },
    indexes: { icon: Hash, className: "size-4 shrink-0 text-slate-500" },
    dictionaries: { icon: BookOpen, className: "size-4 shrink-0 text-slate-500" },
    projections: { icon: PanelTop, className: "size-4 shrink-0 text-slate-500" },
    search_indexes: { icon: Hash, className: "size-4 shrink-0 text-slate-500" },
    triggers: { icon: Zap, className: "size-4 shrink-0 text-slate-500" },
    sequences: { icon: ListTree, className: "size-4 shrink-0 text-slate-500" },
    extensions: { icon: Puzzle, className: "size-4 shrink-0 text-slate-500" },
    events: { icon: Timer, className: "size-4 shrink-0 text-slate-500" },
    collections: { icon: Box, className: "size-4 shrink-0 text-slate-500" },
    vector_collections: { icon: Box, className: "size-4 shrink-0 text-slate-500" },
    documents: { icon: FileJson, className: "size-4 shrink-0 text-slate-500" },
    node_labels: { icon: CircleDot, className: "size-4 shrink-0 text-slate-500" },
    relationship_types: {
        icon: ArrowLeftRight,
        className: "size-4 shrink-0 text-slate-500",
    },
    partitions: { icon: Server, className: "size-4 shrink-0 text-slate-500" },
    data_streams: { icon: FileText, className: "size-4 shrink-0 text-slate-500" },
};

export function getExplorerNodeVisual(
    nodeType: ExplorerTreeNodeType,
    open: boolean,
): ExplorerNodeVisual {
    if (nodeType === "group") {
        return open ? OPEN_FOLDER_VISUAL : CLOSED_FOLDER_VISUAL;
    }

    return NODE_VISUALS[nodeType] ?? REMOTE_FALLBACK_VISUAL;
}

export function getAssetGroupVisual(
    groupType: AssetGroupType | null | undefined,
    open: boolean,
): ExplorerNodeVisual {
    if (!groupType) {
        return open ? OPEN_ASSET_GROUP_VISUAL : CLOSED_ASSET_GROUP_VISUAL;
    }

    return ASSET_GROUP_VISUALS[groupType] ?? (open ? OPEN_ASSET_GROUP_VISUAL : CLOSED_ASSET_GROUP_VISUAL);
}
