import { useState, useRef } from "react";
import { cva } from "class-variance-authority";
import {
    X,
    CopyX,
    Pin,
    Loader2,
} from "lucide-react";
import {
    DndContext,
    DragOverlay,
    MouseSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import {
    SortableContext,
    horizontalListSortingStrategy,
    useSortable,
} from "@dnd-kit/sortable";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "@/lib/utils";
import {
    useExplorerStore,
    useWorkbenchTabsStore,
    type WorkbenchTab,
} from "@/store";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollBar } from "@/components/ui/scroll-area";
import {
    useWorkbenchTabCloseGuard,
    type WorkbenchTabCloseSource,
} from "@/features/workbench/content/hooks/use-workbench-tab-close-guard";
import {
    getContentTabDisplayTitle,
    getContentTabIcon,
    getContentTabTooltipTitle,
} from "@/features/workbench/content/content-tab-registry";

// ─── Tab Item 样式变体 ─────────────────────────────────────────────────────────

const tabItemVariants = cva(
    [
        "group/tab relative flex shrink-0 items-center gap-1.5 h-full px-3",
        "select-none cursor-pointer border-b-2 transition-colors",
        "text-xs font-medium whitespace-nowrap",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    ],
    {
        variants: {
            active: {
                true: "border-b-primary text-foreground bg-background",
                false: [
                    "border-b-transparent text-muted-foreground",
                    "hover:text-foreground hover:bg-muted/50",
                ],
            },
        },
        defaultVariants: { active: false },
    },
);

function getVisibleOrderedTabs(tabs: WorkbenchTab[]) {
    return [
        ...tabs.filter((tab) => tab.isPinned),
        ...tabs.filter((tab) => !tab.isPinned),
    ];
}

// ─── 单个 Tab Item（纯展示，无拖拽逻辑） ──────────────────────────────────────

interface TabItemProps {
    tab: WorkbenchTab;
    isActive: boolean;
    onActivate: (id: string) => void;
    onClose: (id: string, source: WorkbenchTabCloseSource) => void;
    onCloseOther: (id: string) => void;
    onCloseRight: (id: string) => void;
    onCloseAll: () => void;
    canCloseOther: boolean;
    canCloseRight: boolean;
    canCloseAll: boolean;
    displayTitle: string;
    tooltipTitle: string;
    /** 拖拽预览模式：禁用交互事件 */
    isOverlay?: boolean;
}

function TabItem({
    tab,
    isActive,
    onActivate,
    onClose,
    onCloseOther,
    onCloseRight,
    onCloseAll,
    canCloseOther,
    canCloseRight,
    canCloseAll,
    displayTitle,
    tooltipTitle,
    isOverlay,
}: TabItemProps) {
    const Icon = getContentTabIcon(tab);
    const canCloseCurrent = !tab.isPinned;

    function handleMouseDown(e: React.MouseEvent) {
        if (isOverlay) return;
        if (e.button === 1 && canCloseCurrent) {
            e.preventDefault();
            onClose(tab.id, "tab-middle-click");
        }
    }

    function handleActionClick(e: React.MouseEvent) {
        if (isOverlay || !canCloseCurrent) return;
        e.stopPropagation();
        onClose(tab.id, "tab-close-button");
    }

    const titleNode = isOverlay ? (
        <span className="max-w-[160px] truncate">{displayTitle}</span>
    ) : (
        <Tooltip>
            <TooltipTrigger render={<span className="max-w-[160px] truncate">{displayTitle}</span>} />
            <TooltipContent side="bottom" sideOffset={6}>
                <span className="break-all">{tooltipTitle}</span>
            </TooltipContent>
        </Tooltip>
    );

    const tabButton = (
        <div
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={cn(tabItemVariants({ active: isActive }))}
            onClick={() => !isOverlay && onActivate(tab.id)}
            onMouseDown={handleMouseDown}
        >
            {/* 类型图标 / 执行中 spinner */}
            {tab.isExecuting ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
            ) : (
                <Icon className="size-3.5 shrink-0 opacity-70" />
            )}

            {/* 标题 */}
            {titleNode}

            {tab.isPinned ? (
                <span
                    aria-label={`系统固定标签页 ${displayTitle}`}
                    title="系统固定标签页"
                    className="relative ml-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                >
                    <Pin className="size-3 opacity-70" />
                </span>
            ) : (
                <button
                    type="button"
                    aria-label={`关闭 ${displayTitle}`}
                    title={tab.isDirty ? "有未保存的修改，点击关闭" : "关闭"}
                    onClick={handleActionClick}
                    className={cn(
                        "relative ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm",
                        "transition-all hover:bg-muted-foreground/20",
                        tab.isDirty && "opacity-100",
                        !tab.isDirty && "opacity-0 group-hover/tab:opacity-60 hover:opacity-100!",
                    )}
                >
                    {tab.isDirty && (
                        <span className="absolute size-2 rounded-full bg-amber-400 transition-opacity group-hover/tab:opacity-0" />
                    )}
                    <X
                        className={cn(
                            "size-3 transition-opacity",
                            tab.isDirty
                                ? "opacity-0 group-hover/tab:opacity-100"
                                : "opacity-100",
                        )}
                    />
                </button>
            )}
        </div>
    );

    if (isOverlay) return tabButton;

    return (
        <ContextMenu>
            <ContextMenuTrigger render={tabButton} />
            <ContextMenuContent>
                <ContextMenuItem
                    disabled={!canCloseCurrent}
                    onClick={() => onClose(tab.id, "tab-context-menu")}
                >
                    <X />
                    关闭
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    disabled={!canCloseOther}
                    onClick={() => onCloseOther(tab.id)}
                >
                    <CopyX />
                    关闭其他
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={!canCloseRight}
                    onClick={() => onCloseRight(tab.id)}
                >
                    <CopyX />
                    关闭右侧标签页
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={!canCloseAll}
                    onClick={() => onCloseAll()}
                >
                    <X />
                    全部关闭
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

// ─── SortableTabItem（为 TabItem 注入 dnd-kit 拖拽能力） ───────────────────────

function SortableTabItem(props: TabItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: props.tab.id });

    const style: React.CSSProperties = {
        transform: transform
            ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
            : undefined,
        transition,
        // 原位保留半透明占位，浮动预览由 DragOverlay 负责
        opacity: isDragging ? 0.4 : 1,
        // 拖拽时提升光标体验
        cursor: isDragging ? "grabbing" : "pointer",
    };

    return (
        <div ref={setNodeRef} style={style} className="flex h-full items-stretch" {...attributes} {...listeners}>
            <TabItem {...props} />
        </div>
    );
}

interface ContentTabScrollAreaProps {
    children: React.ReactNode;
    viewportRef: React.Ref<HTMLDivElement>;
    onWheel: React.WheelEventHandler<HTMLDivElement>;
    type: "auto" | "hover";
}

function ContentTabScrollArea({
    children,
    viewportRef,
    onWheel,
    type,
}: ContentTabScrollAreaProps) {
    return (
        <ScrollAreaPrimitive.Root
            data-slot="content-tab-scroll-area"
            className="relative min-w-0 flex-1 overflow-hidden"
        >
            <ScrollAreaPrimitive.Viewport
                ref={viewportRef}
                data-slot="content-tab-scroll-area-viewport"
                onWheel={onWheel}
                className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
            >
                {children}
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar type={type} orientation="horizontal" />
            <ScrollAreaPrimitive.Corner />
        </ScrollAreaPrimitive.Root>
    );
}

// ─── ContentTabBar ─────────────────────────────────────────────────────────────

export function ContentTabBar() {
    const { tabs, activeTabId, activateTab, pinTab, unpinTab, reorderTab } =
        useWorkbenchTabsStore();
    const connections = useExplorerStore((state) => state.connections);
    const {
        requestCloseTab,
        requestCloseOtherTabs,
        requestCloseTabsToRight,
        requestCloseAllTabs,
        closeConfirmationDialog,
    } = useWorkbenchTabCloseGuard();

    const scrollRef = useRef<HTMLDivElement>(null);
    const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(MouseSensor, {
            // 移动超过 5px 才激活拖拽，避免与点击冲突
            activationConstraint: { distance: 5 },
        }),
    );

    // 固定 tab 排在前面
    const pinnedTabs   = tabs.filter((t) => t.isPinned);
    const unpinnedTabs = tabs.filter((t) => !t.isPinned);
    const pinnedIds    = pinnedTabs.map((t) => t.id);
    const unpinnedIds  = unpinnedTabs.map((t) => t.id);

    const draggingTab = draggingTabId ? tabs.find((t) => t.id === draggingTabId) : null;

    function handleDragStart({ active }: DragStartEvent) {
        setDraggingTabId(String(active.id));
    }

    function handleDragEnd({ active, over }: DragEndEvent) {
        setDraggingTabId(null);
        if (!over || active.id === over.id) return;

        const activeTab = tabs.find((t) => t.id === active.id);
        const overTab   = tabs.find((t) => t.id === over.id);
        if (!activeTab || !overTab) return;

        // 跨区：自动 pin / unpin
        if (activeTab.isPinned && !overTab.isPinned) unpinTab(String(active.id));
        if (!activeTab.isPinned && overTab.isPinned) pinTab(String(active.id));

        // 重排（arrayMove 在 store 内执行）
        reorderTab(String(active.id), String(over.id));
    }

    /** 拖拽中禁用横向滚动，避免冲突 */
    function handleWheel(e: React.WheelEvent) {
        if (draggingTabId) return;
        const el = scrollRef.current;
        if (!el || e.deltaY === 0) return;
        e.preventDefault();
        el.scrollLeft += e.deltaY;
    }

    const commonItemProps = {
        onActivate: activateTab,
        onClose: (id: string, source: WorkbenchTabCloseSource) => {
            void requestCloseTab(id, source);
        },
        onCloseOther: (id: string) => {
            void requestCloseOtherTabs(id);
        },
        onCloseRight: (id: string) => {
            void requestCloseTabsToRight(id);
        },
        onCloseAll: () => {
            void requestCloseAllTabs();
        },
    };

    function getTabMenuState(tab: WorkbenchTab) {
        const visibleOrderedTabs = getVisibleOrderedTabs(tabs);
        const tabIndex = visibleOrderedTabs.findIndex((item) => item.id === tab.id);

        return {
            canCloseOther: tabs.some((item) => item.id !== tab.id && !item.isPinned),
            canCloseRight:
                tabIndex >= 0 &&
                visibleOrderedTabs.slice(tabIndex + 1).some((item) => !item.isPinned),
            canCloseAll: tabs.some((item) => !item.isPinned),
        };
    }

    return (
        <TooltipProvider>
            <DndContext
                sensors={sensors}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
            >
                <div
                    role="tablist"
                    aria-label="工作台标签"
                    className="flex h-9 items-stretch border-b bg-muted/30"
                >
                    <ContentTabScrollArea
                        type="hover"
                        viewportRef={scrollRef}
                        onWheel={handleWheel}
                    >
                        <div className="flex h-9 min-w-max items-stretch">
                            {/* 固定区 */}
                            <SortableContext items={pinnedIds} strategy={horizontalListSortingStrategy}>
                                {pinnedTabs.map((tab) => (
                                    <SortableTabItem
                                        key={tab.id}
                                        tab={tab}
                                        isActive={tab.id === activeTabId}
                                        displayTitle={getContentTabDisplayTitle(tab, connections)}
                                        tooltipTitle={getContentTabTooltipTitle(tab, connections)}
                                        {...getTabMenuState(tab)}
                                        {...commonItemProps}
                                    />
                                ))}
                            </SortableContext>

                            {/* 固定/普通分隔线 */}
                            {pinnedTabs.length > 0 && unpinnedTabs.length > 0 && (
                                <div className="my-2 w-px shrink-0 bg-border" />
                            )}

                            {/* 普通区 */}
                            <SortableContext items={unpinnedIds} strategy={horizontalListSortingStrategy}>
                                {unpinnedTabs.map((tab) => (
                                    <SortableTabItem
                                        key={tab.id}
                                        tab={tab}
                                        isActive={tab.id === activeTabId}
                                        displayTitle={getContentTabDisplayTitle(tab, connections)}
                                        tooltipTitle={getContentTabTooltipTitle(tab, connections)}
                                        {...getTabMenuState(tab)}
                                        {...commonItemProps}
                                    />
                                ))}
                            </SortableContext>
                        </div>
                    </ContentTabScrollArea>
                </div>

                {/* 拖拽浮动预览（portal 层，不受 overflow 裁切） */}
                <DragOverlay>
                    {draggingTab && (
                        <div className="flex h-9 items-stretch rounded-md border bg-background shadow-lg">
                            <TabItem
                                tab={draggingTab}
                                isActive={false}
                                displayTitle={getContentTabDisplayTitle(draggingTab, connections)}
                                tooltipTitle={getContentTabTooltipTitle(draggingTab, connections)}
                                isOverlay
                                onActivate={() => {}}
                                onClose={() => {}}
                                onCloseOther={() => {}}
                                onCloseRight={() => {}}
                                onCloseAll={() => {}}
                                canCloseOther={false}
                                canCloseRight={false}
                                canCloseAll={false}
                            />
                        </div>
                    )}
                </DragOverlay>
                {closeConfirmationDialog}
            </DndContext>
        </TooltipProvider>
    );
}
