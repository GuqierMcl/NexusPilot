import { createBrowserRouter } from "react-router";

import { RootLayout } from "@/routes/root-layout";
import { MainLayout } from "@/routes/main-layout";
import { settingsLoader } from "@/routes/settings-loader";
import { SettingsPage } from "@/routes/settings-page";

/**
 * 数据模式路由表（createBrowserRouter）。
 * - `/`：主窗口 {@link MainLayout}（三栏工作台，中间栏为静态内容）
 * - `/settings`：独立设置页
 *
 * @see https://reactrouter.remix.org.cn/start/data/routing
 */
export const router = createBrowserRouter([
    {
        path: "/",
        Component: RootLayout,
        children: [
            { index: true, Component: MainLayout },
            {
                path: "settings",
                loader: settingsLoader,
                Component: SettingsPage,
            },
        ],
    },
]);
