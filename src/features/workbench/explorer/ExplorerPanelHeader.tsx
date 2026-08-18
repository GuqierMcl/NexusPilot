import type React from "react";
import { FolderPlus, Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ExplorerPanelHeaderProps {
    isSearchOpen: boolean;
    searchQuery: string;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    onOpenSearch: () => void;
    onSearchBlur: (event: React.FocusEvent<HTMLDivElement>) => void;
    onSearchQueryChange: (query: string) => void;
    onClearSearch: () => void;
    onOpenCreateFolder: () => void;
    onOpenCreateConnection: () => void;
}

export function ExplorerPanelHeader({
    isSearchOpen,
    searchQuery,
    searchInputRef,
    onOpenSearch,
    onSearchBlur,
    onSearchQueryChange,
    onClearSearch,
    onOpenCreateFolder,
    onOpenCreateConnection,
}: ExplorerPanelHeaderProps) {
    return (
        <>
            <header className="flex items-center justify-between border-b px-4 py-1">
                <h2 className="text-sm font-semibold truncate">连接列表</h2>

                <div className="flex items-center gap-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="搜索"
                        tooltipSide="bottom"
                        aria-label="搜索"
                        onClick={onOpenSearch}
                    >
                        <Search className="size-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="新建文件夹"
                        tooltipSide="bottom"
                        aria-label="新建文件夹"
                        onClick={onOpenCreateFolder}
                    >
                        <FolderPlus className="size-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="新建连接"
                        tooltipSide="bottom"
                        aria-label="新建连接"
                        onClick={onOpenCreateConnection}
                    >
                        <Plus className="size-4" />
                    </Button>
                </div>
            </header>

            {isSearchOpen ? (
                <div
                    className="border-b bg-background/95 px-3 py-2"
                    onBlur={onSearchBlur}
                >
                    <div className="relative flex items-center">
                        <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
                        <Input
                            ref={searchInputRef}
                            value={searchQuery}
                            onChange={(event) =>
                                onSearchQueryChange(event.target.value)
                            }
                            placeholder="搜索连接"
                            className="h-8 rounded-md pl-8 pr-8 text-sm"
                        />
                        {searchQuery.length > 0 ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                title="清空搜索"
                                tooltipSide="bottom"
                                aria-label="清空搜索"
                                className="absolute right-0.5 size-7"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={onClearSearch}
                            >
                                <X className="size-4" />
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </>
    );
}
