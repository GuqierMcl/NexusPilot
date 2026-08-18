import type { AppSettings } from "@/types/settings";

/** 新建或缺省时的推荐默认值（与 {@link AppSettings} 形状一致） */
export const DEFAULT_APP_SETTINGS: AppSettings = {
    common: {
        themeMode: "system",
        language: "system",
        interfaceFontFamilyInput: "",
    },
    notification: {
        systemNotificationsEnabled: true,
        duration: 4000,
        visibleToasts: 3,
    },
    editor: {
        fontFamily: "",
        fontSize: 13,
        lineHeight: 20,
        tabSize: 4,
        wordWrap: "on",
        minimapEnabled: false,
        lineNumbers: "on",
        renderWhitespace: "selection",
    },
    ai: {
        selectedModel: null,
        selectedAgentMode: "ask",
        startupConversation: "new",
        conversationRendering: "standard",
        lastOpenedConversationId: null,
        backgroundNotifications: true,
        showReplyPreview: true,
        notifyOnFailure: false,
    },
};
