/**
 * 应用设置相关类型（持久化、全局 Store、Tauri 配置等）。
 * 按配置组划分，后续可在此增加如 `editor`、`connection` 等分组。
 *
 * 运行时默认值：`@/config/app-settings` 中的 `DEFAULT_APP_SETTINGS`。
 */

/** 主题模式（与 {@link ThemeProvider} 行为一致） */
export type ThemeMode = "light" | "dark" | "system"

/**
 * 界面语言：任意 **BCP 47** 语言标签（如 `zh-CN`、`en-US`、`zh-Hans-CN`）。
 * 约定：使用字面量 `"system"` 表示跟随操作系统语言（需在 i18n 层实现）。
 */
export type AppLanguage = string

/** Monaco 编辑器换行策略 */
export type EditorWordWrap = "on" | "off"

/** Monaco 编辑器行号显示策略 */
export type EditorLineNumbers = "on" | "off"

/** Monaco 空白字符渲染策略 */
export type EditorRenderWhitespace = "none" | "selection" | "all"

/** 通用 / 全局类配置（主题、语言等） */
export type AppSettingsCommon = {
    /** 主题模式 */
    themeMode: ThemeMode
    /** 界面语言 */
    language: AppLanguage
    /** 界面字体 fallback 栈的用户输入，逗号分隔；留空表示使用默认字体栈 */
    interfaceFontFamilyInput: string
}

/** 代码编辑器全局配置（Monaco 及其项目级封装读取） */
export type AppSettingsEditor = {
    /** 编辑器字体 fallback 栈，留空表示使用 Monaco 默认字体 */
    fontFamily: string
    /** 字号，单位 px */
    fontSize: number
    /** 行高，单位 px */
    lineHeight: number
    /** Tab 缩进宽度 */
    tabSize: number
    /** 自动换行策略 */
    wordWrap: EditorWordWrap
    /** 是否启用 minimap */
    minimapEnabled: boolean
    /** 是否显示行号 */
    lineNumbers: EditorLineNumbers
    /** 空白字符渲染策略 */
    renderWhitespace: EditorRenderWhitespace
}

export type AiRuntimeSelectedModel = {
    providerId: string
    modelId: string
}

export type AiRuntimeSelectedAgentMode = "ask" | "query" | "agent"

/** 智能体面板启动时应显示的新对话或上次打开的对话。 */
export type AiConversationStartupOption = "new" | "restore-last"

/** 智能体对话的消息列表渲染策略。 */
export type AiConversationRendering = "standard" | "virtualized"

export type AppSettingsAI = {
    /**
     * 用户在 Workbench Agent 面板中显式选择的模型。
     * 这是 NexusPilot 本体 UI 偏好，不属于 AI Runtime Store。
     */
    selectedModel: AiRuntimeSelectedModel | null
    /**
     * 用户在 Workbench Agent 面板中显式选择的内置 agent mode。
     * 这是 NexusPilot 本体 UI 偏好；每次 Run 的事实值由 AI Runtime Store 记录。
     */
    selectedAgentMode: AiRuntimeSelectedAgentMode
    /** 智能体面板启动时的对话选择策略。 */
    startupConversation: AiConversationStartupOption
    /** 智能体消息列表的渲染策略。 */
    conversationRendering: AiConversationRendering
    /** 最近一次打开的 Runtime 对话，仅用于本机启动恢复。 */
    lastOpenedConversationId: string | null
    /** 主窗口失焦时，是否发送智能体执行状态的系统通知。 */
    backgroundNotifications: boolean
    /** 系统通知是否展示智能体回复的文本预览。 */
    showReplyPreview: boolean
    /** 智能体执行失败时是否发送系统通知。 */
    notifyOnFailure: boolean
}

/** 通知配置 */
export type AppSettingsNotification = {
    /** 是否允许任意模块发送系统原生通知。 */
    systemNotificationsEnabled: boolean
    /** 通知自动关闭时长（毫秒），Infinity 表示永不自动关闭 */
    duration: number
    /** 最大可见通知数量 */
    visibleToasts: number
}

/** 应用用户可配置项集合（按分组组织） */
export type AppSettings = {
    common: AppSettingsCommon
    editor: AppSettingsEditor
    notification: AppSettingsNotification
    ai: AppSettingsAI
}
