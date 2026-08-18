import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SettingsSectionProps {
    title: string;
    description?: string;
    children: ReactNode;
    className?: string;
}

export function SettingsSection({
    title,
    description,
    children,
    className,
}: SettingsSectionProps) {
    return (
        <section className={cn("flex flex-col gap-3", className)}>
            <div className="flex flex-col gap-1">
                <h4 className="text-sm font-semibold text-foreground">
                    {title}
                </h4>
                {description && (
                    <p className="text-sm text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
            {/* <div className="border-muted border-l-2 pl-4">{children}</div> */}
            <div className="border-muted pl-4">{children}</div>
        </section>
    );
}
