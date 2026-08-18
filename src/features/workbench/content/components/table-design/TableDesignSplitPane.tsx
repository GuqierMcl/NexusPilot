import type { ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";

interface TableDesignSplitPaneProps {
    detailsTitle: string;
    isDetailsOpen: boolean;
    onDetailsOpenChange: (isOpen: boolean) => void;
    main: ReactNode;
    details: ReactNode;
}

export function TableDesignSplitPane({
    detailsTitle,
    isDetailsOpen,
    onDetailsOpenChange,
    main,
    details,
}: TableDesignSplitPaneProps) {
    if (!isDetailsOpen) {
        return (
            <div className="flex h-full min-h-0 min-w-0">
                <div className="min-w-0 flex-1 overflow-hidden">{main}</div>
                <div className="flex w-10 shrink-0 justify-center border-l bg-muted/20 pt-2">
                    <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => onDetailsOpenChange(true)}
                        title={`展开${detailsTitle}`}
                    >
                        <PanelRightOpen className="size-4" />
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0">
            <ResizablePanel defaultSize="76%" minSize="45%">
                <div className="h-full min-w-0 overflow-hidden">{main}</div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="24%" minSize="260px" maxSize="42%">
                <aside className="flex h-full min-h-0 flex-col bg-background">
                    <div className="flex py-1.5 shrink-0 items-center justify-between border-b px-3">
                        <span className="text-sm font-medium">{detailsTitle}</span>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => onDetailsOpenChange(false)}
                            title={`折叠${detailsTitle}`}
                        >
                            <PanelRightClose className="size-4" />
                        </Button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-hidden">{details}</div>
                </aside>
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
