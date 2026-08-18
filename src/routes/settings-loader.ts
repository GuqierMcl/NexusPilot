/** 设置页数据加载（单独文件，避免与组件同文件导致 Fast Refresh 报错） */
export async function settingsLoader() {
    return {
        title: "设置",
        hint: "配置应用外观、编辑器、AI 服务供应商和模型。",
    };
}

export type SettingsLoaderData = Awaited<ReturnType<typeof settingsLoader>>;
