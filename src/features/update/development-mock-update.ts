import { Update, type DownloadEvent } from "@tauri-apps/plugin-updater";

const DEVELOPMENT_MOCK_RELEASE_NOTES = [
    "🚀 开发环境模拟更新，用于验证更新弹窗、更新日志滚动、按钮状态与安装流程提示。",
    "",
    "✨ 主要变化",
    "- 🎨 优化数据表格高级编辑器弹窗，提升 JSON 与长文本编辑体验。",
    "- ⚡ 调整中间内容区标签栏，标签过多时支持横向滚动。",
    "- 📝 更新弹窗中的更新日志现在拥有稳定的滚动区域，长日志不会撑破弹窗。",
    "- 🔔 新版本提示 toast 仅展示简要信息，完整更新日志保留在弹窗中查看。",
    "",
    "🐛 细节修复",
    "- 🩹 修复弹窗底部状态文字与操作按钮布局不自然的问题。",
    "- 📐 调整编辑弹窗宽度，使代码编辑器在宽屏下拥有更舒服的阅读空间。",
    "- ⚠️ Dirty 状态关闭时增加确认，减少误关导致的编辑内容丢失。",
    "- 🔧 优化开发测试路径，关于页检查更新按钮在开发环境会直接展示本模拟版本。",
    "",
    "✅ 验证建议",
    "- 👁️ 检查这段长更新日志是否能滚动到底部。",
    "- 📏 检查弹窗高度、底部按钮、标题区域和徽标在不同窗口宽度下是否稳定。",
    "- 🔍 检查 toast 是否只显示简要版本信息，不再展示这段完整日志。",
    "- 🔄 检查关闭弹窗后，再次点击关于页检查更新按钮是否还能打开模拟更新。",
    "",
    "📦 其他",
    "- 💡 这是一段额外的占位说明，用来模拟真实发布中较长的 changelog。",
    "- 🔥 实际生产更新仍然完全依赖 Tauri updater 返回的真实版本信息，不会使用这份开发 mock 数据。",
    "",
    "常用 Emoji 速查",
    "- ✨ 新功能 (Feature)",
    "- 🐛 修复 (Bug Fix)",
    "- 🎨 样式/UI (Style)",
    "- ⚡ 性能 (Performance)",
    "- 📝 文档 (Docs)",
    "- 🔧 工具/配置 (Chore)",
    "- ✅ 完成 (Done)",
    "- 🚀 发布 (Release)",
    "- ⚠️ 警告 (Warning)",
    "- 🔥 重要 (Important)",
    "- 📦 依赖/打包 (Package)",
    "- 🩹 小修复 (Hotfix)",
    "- 🔔 通知 (Notification)",
    "- 🔍 搜索/调试 (Debug)",
].join("\n");

export function createDevelopmentMockUpdate(): Update {
    const update = new Update({
        rid: -1,
        currentVersion: "0.1.0-dev",
        version: "9.9.9-dev-mock",
        date: "2077-07-01T10:00:00+08:00",
        body: DEVELOPMENT_MOCK_RELEASE_NOTES,
        rawJson: {
            devMock: true,
            source: "settings-about",
        },
    });

    update.download = async (onEvent?: (event: DownloadEvent) => void) => {
        onEvent?.({
            event: "Started",
            data: { contentLength: 4096 },
        });
        onEvent?.({
            event: "Progress",
            data: { chunkLength: 4096 },
        });
        onEvent?.({ event: "Finished" });
    };
    update.install = async () => {};
    update.close = async () => {};

    return update;
}
