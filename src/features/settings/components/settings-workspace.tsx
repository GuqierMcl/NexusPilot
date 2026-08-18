import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import {
    SETTINGS_SECTIONS,
    type SettingsSection,
} from "../settings-sections";

interface SettingsWorkspaceProps {
    activeSection: SettingsSection;
    onActiveSectionChange: (section: SettingsSection) => void;
    className?: string;
}

export function SettingsWorkspace({
    activeSection,
    onActiveSectionChange,
    className,
}: SettingsWorkspaceProps) {
    const [appVersion, setAppVersion] = useState("0.1.0");
    const activeSectionConfig =
        SETTINGS_SECTIONS.find((section) => section.key === activeSection) ??
        SETTINGS_SECTIONS[0];
    const ActivePanel = activeSectionConfig.Panel;

    useEffect(() => {
        getVersion()
            .then(setAppVersion)
            .catch(() => setAppVersion("0.1.0"));
    }, []);

    return (
        <div className={cn("flex min-h-0 flex-1 gap-0", className)}>
            <nav className="flex min-h-0 w-36 shrink-0 flex-col">
                <ScrollArea className="min-h-0 flex-1">
                    <div className="pr-2">
                        <div className="flex flex-col gap-0">
                            {SETTINGS_SECTIONS.map((item, index) => {
                                const showGroupLabel =
                                    index === 0 ||
                                    SETTINGS_SECTIONS[index - 1].group !== item.group;

                                return (
                                    <div key={item.key}>
                                        {showGroupLabel && (
                                            <>
                                                {index > 0 && (
                                                    <Separator className="my-2" />
                                                )}
                                                <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                                                    {item.group}
                                                </p>
                                            </>
                                        )}
                                        <Button
                                            type="button"
                                            variant={
                                                activeSection === item.key
                                                    ? "secondary"
                                                    : "ghost"
                                            }
                                            className="w-full justify-start gap-2"
                                            onClick={() => onActiveSectionChange(item.key)}
                                        >
                                            <item.icon className="size-4" />
                                            {item.label}
                                        </Button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </ScrollArea>

                <div className="mt-auto px-3 pb-1 text-sm text-muted-foreground">
                    <p className="font-medium">NexusPilot</p>
                    <p>{appVersion}</p>
                </div>
            </nav>

            <Separator orientation="vertical" className="mx-2" />

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                <header className="flex h-10 shrink-0 items-center pr-10 pl-1">
                    <h3 className="text-xl font-medium">
                        {activeSectionConfig.title}
                    </h3>
                </header>

                <ScrollArea className="min-h-0 flex-1 pt-5">
                    <div className="pr-3 pl-1 pb-1">
                        <ActivePanel onNavigate={onActiveSectionChange} />
                    </div>
                </ScrollArea>
            </section>
        </div>
    );
}
