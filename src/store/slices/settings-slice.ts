import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createTauriSettingsPersistStorage } from "@/store/adapters/tauri-settings-persist-storage";
import { STORE_KEY_APP_SETTINGS } from "@/store/constants";
import { DEFAULT_APP_SETTINGS } from "@/config/app-settings";
import type {
    AiConversationRendering,
    AiConversationStartupOption,
    AiRuntimeSelectedAgentMode,
    AiRuntimeSelectedModel,
    AppSettings,
    AppSettingsEditor,
    EditorLineNumbers,
    EditorRenderWhitespace,
    EditorWordWrap,
    ThemeMode,
} from "@/types/settings";

export type SettingsState = AppSettings & {
    setThemeMode: (themeMode: ThemeMode) => void;
    setLanguage: (language: string) => void;
    setInterfaceFontFamilyInput: (value: string) => void;
    setEditorSettings: (settings: Partial<AppSettingsEditor>) => void;
    setEditorFontFamily: (fontFamily: string) => void;
    setEditorFontSize: (fontSize: number) => void;
    setEditorLineHeight: (lineHeight: number) => void;
    setEditorTabSize: (tabSize: number) => void;
    setEditorWordWrap: (wordWrap: EditorWordWrap) => void;
    setEditorMinimapEnabled: (minimapEnabled: boolean) => void;
    setEditorLineNumbers: (lineNumbers: EditorLineNumbers) => void;
    setEditorRenderWhitespace: (
        renderWhitespace: EditorRenderWhitespace,
    ) => void;
    setAiRuntimeSelectedModel: (
        selectedModel: AiRuntimeSelectedModel | null,
    ) => void;
    setAiRuntimeSelectedAgentMode: (
        selectedAgentMode: AiRuntimeSelectedAgentMode,
    ) => void;
    setAiConversationStartupOption: (
        startupConversation: AiConversationStartupOption,
    ) => void;
    setAiConversationRendering: (
        conversationRendering: AiConversationRendering,
    ) => void;
    setLastOpenedConversationId: (conversationId: string | null) => void;
    setAiBackgroundNotifications: (enabled: boolean) => void;
    setAiShowReplyPreview: (enabled: boolean) => void;
    setAiNotifyOnFailure: (enabled: boolean) => void;
    setSystemNotificationsEnabled: (enabled: boolean) => void;
    setNotificationDuration: (duration: number) => void;
    setNotificationVisibleToasts: (visibleToasts: number) => void;
};

type LegacyNotificationSettings = Partial<AppSettings["notification"]> & {
    position?: unknown;
    closeButton?: unknown;
    richColors?: unknown;
};

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            ...DEFAULT_APP_SETTINGS,
            setThemeMode: (themeMode) =>
                set((s) => ({ common: { ...s.common, themeMode } })),
            setLanguage: (language) =>
                set((s) => ({ common: { ...s.common, language } })),
            setInterfaceFontFamilyInput: (interfaceFontFamilyInput) =>
                set((s) => ({ common: { ...s.common, interfaceFontFamilyInput } })),
            setEditorSettings: (settings) =>
                set((s) => ({ editor: { ...s.editor, ...settings } })),
            setEditorFontFamily: (fontFamily) =>
                set((s) => ({ editor: { ...s.editor, fontFamily } })),
            setEditorFontSize: (fontSize) =>
                set((s) => ({ editor: { ...s.editor, fontSize } })),
            setEditorLineHeight: (lineHeight) =>
                set((s) => ({ editor: { ...s.editor, lineHeight } })),
            setEditorTabSize: (tabSize) =>
                set((s) => ({ editor: { ...s.editor, tabSize } })),
            setEditorWordWrap: (wordWrap) =>
                set((s) => ({ editor: { ...s.editor, wordWrap } })),
            setEditorMinimapEnabled: (minimapEnabled) =>
                set((s) => ({ editor: { ...s.editor, minimapEnabled } })),
            setEditorLineNumbers: (lineNumbers) =>
                set((s) => ({ editor: { ...s.editor, lineNumbers } })),
            setEditorRenderWhitespace: (renderWhitespace) =>
                set((s) => ({ editor: { ...s.editor, renderWhitespace } })),
            setAiRuntimeSelectedModel: (selectedModel) =>
                set((s) => ({ ai: { ...s.ai, selectedModel } })),
            setAiRuntimeSelectedAgentMode: (selectedAgentMode) =>
                set((s) => ({ ai: { ...s.ai, selectedAgentMode } })),
            setAiConversationStartupOption: (startupConversation) =>
                set((s) => ({ ai: { ...s.ai, startupConversation } })),
            setAiConversationRendering: (conversationRendering) =>
                set((s) => ({ ai: { ...s.ai, conversationRendering } })),
            setLastOpenedConversationId: (lastOpenedConversationId) =>
                set((s) => ({ ai: { ...s.ai, lastOpenedConversationId } })),
            setAiBackgroundNotifications: (backgroundNotifications) =>
                set((s) => ({ ai: { ...s.ai, backgroundNotifications } })),
            setAiShowReplyPreview: (showReplyPreview) =>
                set((s) => ({ ai: { ...s.ai, showReplyPreview } })),
            setAiNotifyOnFailure: (notifyOnFailure) =>
                set((s) => ({ ai: { ...s.ai, notifyOnFailure } })),
            setSystemNotificationsEnabled: (systemNotificationsEnabled) =>
                set((s) => ({
                    notification: { ...s.notification, systemNotificationsEnabled },
                })),
            setNotificationDuration: (duration) =>
                set((s) => ({ notification: { ...s.notification, duration } })),
            setNotificationVisibleToasts: (visibleToasts) =>
                set((s) => ({ notification: { ...s.notification, visibleToasts } })),
        }),
        {
            name: STORE_KEY_APP_SETTINGS,
            version: 1,
            storage: createJSONStorage(() => createTauriSettingsPersistStorage()),
            partialize: (s) => ({
                common: s.common,
                editor: s.editor,
                notification: s.notification,
                ai: s.ai,
            }),
            merge: (persistedState, currentState) => {
                const persisted = persistedState as Partial<AppSettings> | undefined;
                const persistedNotification = persisted?.notification;
                return {
                    ...currentState,
                    ...persisted,
                    common: {
                        ...currentState.common,
                        ...persisted?.common,
                    },
                    editor: {
                        ...currentState.editor,
                        ...persisted?.editor,
                    },
                    notification: {
                        ...currentState.notification,
                        systemNotificationsEnabled:
                            persistedNotification?.systemNotificationsEnabled ??
                            currentState.notification.systemNotificationsEnabled,
                        duration:
                            persistedNotification?.duration ??
                            currentState.notification.duration,
                        visibleToasts:
                            persistedNotification?.visibleToasts ??
                            currentState.notification.visibleToasts,
                    },
                    ai: {
                        ...currentState.ai,
                        ...persisted?.ai,
                        selectedAgentMode:
                            persisted?.ai?.selectedAgentMode ??
                            currentState.ai.selectedAgentMode,
                    },
                };
            },
            migrate: (persistedState, version) => {
                if (version >= 1) return persistedState;

                const persisted = persistedState as Partial<AppSettings>;
                const {
                    position: _position,
                    closeButton: _closeButton,
                    richColors: _richColors,
                    ...notification
                } = (persisted.notification ?? {}) as LegacyNotificationSettings;

                return {
                    ...persisted,
                    notification,
                };
            },
        },
    ),
);
