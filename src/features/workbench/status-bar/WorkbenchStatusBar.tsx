import type { FC } from "react";

import { StatusBarItem } from "./components/StatusBarItem";
import { useWorkbenchStatusItems } from "./hooks/useWorkbenchStatusItems";
import type { WorkbenchStatusItemModel } from "./types";

function renderStatusItems(items: WorkbenchStatusItemModel[]) {
    return items.map((item) => (
        <StatusBarItem
            key={item.id}
            icon={item.icon}
            iconClassName={item.iconClassName}
            label={item.label}
            title={item.title}
            tooltipContent={item.tooltipContent}
            tone={item.tone}
            width={item.width}
            onClick={item.onClick}
            onMouseEnter={item.onMouseEnter}
            onMouseLeave={item.onMouseLeave}
        />
    ));
}

export const WorkbenchStatusBar: FC = () => {
    const items = useWorkbenchStatusItems();

    return (
        <footer className="flex h-6 shrink-0 border-t bg-background px-2 text-xs text-muted-foreground">
            <div className="flex min-w-0 flex-1 gap-2 overflow-hidden">
                {renderStatusItems(items.left)}
            </div>

            <div className="ml-2 flex max-w-[50%] shrink-0 justify-end gap-2 overflow-hidden">
                {renderStatusItems(items.right)}
            </div>
        </footer>
    );
};
