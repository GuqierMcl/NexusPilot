import { useState } from "react";
import { ChevronDown, ChevronRight, Database } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
    getDatabaseIcon,
} from "@/components/icons/database";
import {
    listDriverConfigs,
} from "@/features/workbench/explorer/driver-configs";
import {
    DATABASE_CATEGORY_LABELS,
} from "@/features/workbench/explorer/driver-configs/types";
import type { ConnectionDriver } from "@/types";
import type { DatabaseIconKey } from "@/components/icons/database";
import type { DatabaseCategory } from "@/features/workbench/explorer/driver-configs/types";

export type SelectDatabaseTypeDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    targetFolderId: string | null;
    onNext: (driver: ConnectionDriver, folderId: string | null) => void;
};

type DatabasePickerItem = {
    driver: ConnectionDriver | null;
    displayName: string;
    iconKey: DatabaseIconKey;
    pickerDescription: string;
    category: DatabaseCategory;
    isImplemented: boolean;
    badge?: string;
};

const ALL_DATABASE_TYPES: DatabasePickerItem[] = [
    // RDBMS
    { driver: "mysql", displayName: "MySQL", iconKey: "mysql", pickerDescription: "开源关系型数据库，常用于 Web 应用、事务数据和业务系统。", category: "rdbms", isImplemented: true },
    { driver: "postgres", displayName: "PostgreSQL", iconKey: "postgresql", pickerDescription: "功能完整的开源关系型数据库，擅长复杂查询和扩展能力。", category: "rdbms", isImplemented: true },
    { driver: "oracle", displayName: "Oracle Database", iconKey: "oracle", pickerDescription: "企业级关系型数据库，面向高可靠、高并发和核心业务。", category: "rdbms", isImplemented: true },
    { driver: "sqlite", displayName: "SQLite", iconKey: "sqlite", pickerDescription: "嵌入式关系型数据库，单文件存储，适合本地应用和轻量数据。", category: "rdbms", isImplemented: true },
    { driver: null, displayName: "Microsoft SQL Server", iconKey: "microsoft-sql-server", pickerDescription: "微软关系型数据库，常用于 Windows/.NET 生态和企业系统。", category: "rdbms", isImplemented: false },
    // Analytics
    { driver: "clickhouse", displayName: "ClickHouse", iconKey: "clickhouse", pickerDescription: "列式分析数据库，面向实时分析、日志和大规模 OLAP 查询场景。", category: "analytics", isImplemented: true, badge: "NEW" },
    // Document
    { driver: null, displayName: "MongoDB", iconKey: "mongodb", pickerDescription: "文档型数据库，以 JSON 类文档存储半结构化数据。", category: "document", isImplemented: false },
    // Key-Value
    { driver: "redis", displayName: "Redis", iconKey: "redis", pickerDescription: "内存型键值数据库，常用于缓存、会话、队列和实时数据。", category: "key-value", isImplemented: true },
    // Vector
    { driver: null, displayName: "Pinecone", iconKey: "pinecone", pickerDescription: "托管向量数据库，用于语义搜索、RAG 和相似度检索。", category: "vector", isImplemented: false },
    { driver: null, displayName: "Milvus", iconKey: "milvus", pickerDescription: "开源向量数据库，面向大规模向量检索和 AI 工作负载。", category: "vector", isImplemented: false },
    { driver: null, displayName: "Weaviate", iconKey: "weaviate", pickerDescription: "向量搜索数据库，支持对象数据、向量检索和混合搜索。", category: "vector", isImplemented: false },
    { driver: null, displayName: "Qdrant", iconKey: "qdrant", pickerDescription: "高性能向量数据库，适合相似度搜索和推荐场景。", category: "vector", isImplemented: false },
    { driver: null, displayName: "Chroma", iconKey: "chroma", pickerDescription: "轻量向量数据库，常用于本地 AI 应用和原型验证。", category: "vector", isImplemented: false },
    // Graph
    { driver: null, displayName: "Neo4j", iconKey: "neo4j", pickerDescription: "图数据库，用节点和关系建模高度关联的数据。", category: "graph", isImplemented: false },
    { driver: null, displayName: "Amazon Neptune", iconKey: "aws-amazon-neptune", pickerDescription: "AWS 托管图数据库，支持属性图和 RDF 图工作负载。", category: "graph", isImplemented: false },
    { driver: null, displayName: "ArangoDB", iconKey: "arangodb", pickerDescription: "多模型数据库，支持文档、图和键值数据模型。", category: "graph", isImplemented: false },
    // Search
    { driver: null, displayName: "Elasticsearch", iconKey: "elasticsearch", pickerDescription: "分布式搜索与分析引擎，适合全文检索和日志分析。", category: "search", isImplemented: false },
];

const ALL_CATEGORIES: DatabaseCategory[] = [
    "rdbms",
    "analytics",
    "key-value",
    "vector",
    "graph",
    "document",
    "search",
];

function getIconForDriver(driver: ConnectionDriver | null) {
    const configs = listDriverConfigs();
    const config = configs.find((c) => c.driver === driver);
    return config?.pickerIcon ?? null;
}

function getIconForItem(item: DatabasePickerItem) {
    return getDatabaseIcon(item.iconKey)
        ?? (item.isImplemented ? getIconForDriver(item.driver) : null);
}

function getDriverFromItem(item: DatabasePickerItem): ConnectionDriver | null {
    if (!item.isImplemented || !item.driver) return null;
    return item.driver as ConnectionDriver;
}

export function SelectDatabaseTypeDialog({
    open,
    onOpenChange,
    targetFolderId,
    onNext,
}: SelectDatabaseTypeDialogProps) {
    const [selectedDriver, setSelectedDriver] = useState<ConnectionDriver | null>(null);
    const [openCategories, setOpenCategories] = useState<Set<DatabaseCategory>>(
        new Set(ALL_CATEGORIES)
    );

    function handleDialogOpenChange(nextOpen: boolean) {
        onOpenChange(nextOpen);
        if (!nextOpen) {
            setSelectedDriver(null);
        }
    }

    function handleNext() {
        if (selectedDriver) {
            onNext(selectedDriver, targetFolderId);
            handleDialogOpenChange(false);
        }
    }

    function toggleCategory(category: DatabaseCategory) {
        setOpenCategories((prev) => {
            const next = new Set(prev);
            if (next.has(category)) {
                next.delete(category);
            } else {
                next.add(category);
            }
            return next;
        });
    }

    function handleItemClick(item: DatabasePickerItem) {
        if (!item.isImplemented) return;
        const driver = getDriverFromItem(item);
        if (driver) {
            setSelectedDriver(driver);
        }
    }

    const groupedItems = ALL_CATEGORIES.map((category) => ({
        category,
        label: DATABASE_CATEGORY_LABELS[category],
        items: ALL_DATABASE_TYPES.filter((item) => item.category === category),
    }));

    return (
        <Dialog open={open} onOpenChange={handleDialogOpenChange} >
            <DialogContent className="sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>选择数据库类型</DialogTitle>
                    <DialogDescription>开启你的数据探索之旅。</DialogDescription>
                </DialogHeader>

                <ScrollArea className="max-h-[60vh]">
                <div className="space-y-4 py-4 pr-4">
                    {groupedItems.map(({ category, label, items }) => (
                        <Collapsible
                            key={category}
                            open={openCategories.has(category)}
                            onOpenChange={() => toggleCategory(category)}
                        >
                            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-sm font-medium">
                                {openCategories.has(category) ? (
                                    <ChevronDown className="size-4" />
                                ) : (
                                    <ChevronRight className="size-4" />
                                )}
                                {label}
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <div className="grid grid-cols-3 gap-3 pt-2">
                                    {items.map((item) => {
                                        const Icon = getIconForItem(item);
                                        const isSelected =
                                            item.isImplemented &&
                                            selectedDriver === item.driver;

                                        return (
                                            <button
                                                key={item.displayName}
                                                type="button"
                                                onClick={() => handleItemClick(item)}
                                                disabled={!item.isImplemented}
                                                className={cn(
                                                    "group/item relative flex min-h-24 w-full items-center gap-4 rounded-lg border p-4 text-left transition-colors",
                                                    item.isImplemented
                                                        ? "cursor-pointer border-border hover:border-primary/50 hover:bg-muted/50"
                                                        : "cursor-not-allowed border-dashed border-muted-foreground/20 bg-muted/30 opacity-60",
                                                    isSelected &&
                                                        "border-primary bg-primary/5"
                                                )}
                                            >
                                                <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-background/70 ring-1 ring-border/70">
                                                    {Icon ? (
                                                        <Icon className="max-h-8 max-w-10" />
                                                    ) : (
                                                        <Database className="size-8 text-muted-foreground" />
                                                    )}
                                                </span>
                                                <span className="flex min-w-0 flex-1 flex-col gap-1 pr-12">
                                                    <span className="line-clamp-1 text-sm font-medium leading-snug">
                                                        {item.displayName}
                                                    </span>
                                                    <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                                        {item.pickerDescription}
                                                    </span>
                                                </span>
                                                {item.badge && (
                                                    <span className="absolute right-2 top-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                                        {item.badge}
                                                    </span>
                                                )}
                                                {!item.isImplemented && (
                                                    <span className="absolute right-2 top-2 rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                                        即将上线
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </CollapsibleContent>
                        </Collapsible>
                    ))}
                </div>
                </ScrollArea>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => handleDialogOpenChange(false)}
                    >
                        取消
                    </Button>
                    <Button onClick={handleNext} disabled={!selectedDriver}>
                        下一步
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
