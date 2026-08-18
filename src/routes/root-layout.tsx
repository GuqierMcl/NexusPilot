import { QueryClientProvider } from "@tanstack/react-query";
import { Outlet } from "react-router";

import { AiRuntimeHealthProbe } from "@/components/provider/ai-runtime-health-probe";
import { WorkbenchRuntimeProjection } from "@/components/provider/workbench-runtime-projection";
import { ThemeProvider } from "@/components/provider/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query-client";
import { useSettingsStore } from "@/store/slices/settings-slice";
import { UpdateDialog } from "@/features/update/UpdateDialog";
import { UpdateProbe } from "@/features/update/UpdateProbe";

export function RootLayout() {
    const {
        duration,
        visibleToasts,
    } = useSettingsStore((s) => s.notification);

    return (
        <QueryClientProvider client={queryClient}>
            <AiRuntimeHealthProbe />
            <WorkbenchRuntimeProjection />
            <UpdateProbe />
            <ThemeProvider>
                <main className="h-screen overflow-hidden bg-background">
                    <TooltipProvider>
                        <Outlet />
                    </TooltipProvider>
                    <Toaster
                        timeout={duration === Infinity ? 0 : duration}
                        limit={visibleToasts}
                    />
                    <UpdateDialog />
                </main>
            </ThemeProvider>
        </QueryClientProvider>
    );
}
