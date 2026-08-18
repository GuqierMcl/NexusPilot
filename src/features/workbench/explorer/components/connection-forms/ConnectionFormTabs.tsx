import type { ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";

export type ConnectionFormTab = {
    value: string;
    label: ReactNode;
    content: ReactNode;
    disabled?: boolean;
};

export interface ConnectionFormTabsProps {
    tabs: ConnectionFormTab[];
    defaultValue?: string;
}

export function ConnectionFormTabs({
    tabs,
    defaultValue,
}: ConnectionFormTabsProps) {
    const activeDefault = tabs.some((tab) => tab.value === defaultValue)
        ? defaultValue
        : tabs[0]?.value;

    if (!activeDefault) {
        return null;
    }

    return (
        <Tabs
            defaultValue={activeDefault}
            className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
        >
            <TabsList
                className="h-auto min-h-8 w-full shrink-0 flex-wrap justify-start gap-1 p-1"
                variant="line"
            >
                {tabs.map((tab) => (
                    <TabsTrigger
                        key={tab.value}
                        value={tab.value}
                        disabled={tab.disabled}
                    >
                        {tab.label}
                    </TabsTrigger>
                ))}
            </TabsList>

            <div className="relative min-h-0 flex-1 overflow-hidden">
                {tabs.map((tab) => (
                    <TabsContent
                        key={tab.value}
                        value={tab.value}
                        className="absolute inset-0 mt-0 h-full min-h-0 overflow-hidden data-hidden:hidden"
                    >
                        <ScrollArea className="h-full min-h-0">
                            <div className="pt-4 pr-3 pb-4">
                                {tab.content}
                            </div>
                        </ScrollArea>
                    </TabsContent>
                ))}
            </div>
        </Tabs>
    );
}
