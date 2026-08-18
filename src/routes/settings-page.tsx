import { useEffect, useState } from "react";
import { NavLink, useLoaderData, useSearchParams } from "react-router";

import { AppTitleBar } from "@/components/layout/AppTitleBar";
import { SettingsWorkspace } from "@/features/settings/components/settings-workspace";
import {
    DEFAULT_SETTINGS_SECTION,
    isSettingsSection,
    type SettingsSection,
} from "@/features/settings/settings-sections";

import type { SettingsLoaderData } from "./settings-loader";

export function SettingsPage() {
    const { title, hint } = useLoaderData() as SettingsLoaderData;
    const [searchParams] = useSearchParams();
    const sectionParam = searchParams.get("section");
    const [activeSection, setActiveSection] = useState<SettingsSection>(
        isSettingsSection(sectionParam) ? sectionParam : DEFAULT_SETTINGS_SECTION,
    );

    useEffect(() => {
        const nextSection = searchParams.get("section");
        if (isSettingsSection(nextSection)) {
            setActiveSection(nextSection);
        }
    }, [searchParams]);

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <AppTitleBar>
                <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                            App
                        </p>
                        <p className="text-sm font-medium text-foreground">{title}</p>
                    </div>
                    <span className="min-w-0 truncate">
                        {hint}
                    </span>
                </div>
            </AppTitleBar>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
                <NavLink
                    to="/"
                    className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                    ← 返回工作台
                </NavLink>

                <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground">
                    <SettingsWorkspace
                        activeSection={activeSection}
                        onActiveSectionChange={setActiveSection}
                    />
                </section>
            </div>
        </div>
    );
}
