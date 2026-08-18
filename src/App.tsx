import { RouterProvider } from "react-router";

import { router } from "./router";

import { Spinner } from "@/components/ui/spinner";
import { useWorkbenchWindowCloseGuard } from "@/features/workbench/content/hooks/use-workbench-window-close-guard";
import { useAppBootstrap } from "@/hooks/use-app-bootstrap";

/** 应用壳：仅挂载数据路由；全局 Provider 在 `routes/root-layout` */
export default function App() {
    const { ready } = useAppBootstrap();
    const { closeConfirmationDialog } = useWorkbenchWindowCloseGuard();

    if (!ready) {
        return (
            <div
                className="flex h-screen flex-col items-center justify-center gap-4 bg-background"
                aria-live="polite"
                aria-busy="true"
            >
                <Spinner className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">正在初始化…</p>
            </div>
        );
    }

    return (
        <>
            <RouterProvider router={router} />
            {closeConfirmationDialog}
        </>
    );
}
