import {
    BellIcon,
    BoxIcon,
    BrainCircuitIcon,
    CloudIcon,
    CodeIcon,
    InfoIcon,
    LockKeyholeIcon,
    ServerIcon,
    SettingsIcon,
    SlidersHorizontalIcon,
    type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { AboutPanel } from "./panels/AboutPanel";
import { AiRuntimePanel } from "./panels/AiRuntimePanel";
import { AiPreferencesPanel } from "./panels/AiPreferencesPanel";
import { CommonSettingsPanel } from "./panels/CommonSettingsPanel";
import { CloudOverviewPanel } from "./panels/CloudOverviewPanel";
import { SyncSecurityPanel } from "./panels/SyncSecurityPanel";
import { EditorSettingsPanel } from "./panels/EditorSettingsPanel";
import { ModelListPanel } from "./panels/ModelListPanel";
import { ModelProviderPanel } from "./panels/model-provider";
import { NotificationSettingsPanel } from "./panels/NotificationSettingsPanel";

export type SettingsPanelProps = {
    onNavigate?: (section: SettingsSection) => void;
};

interface SettingsSectionDefinition {
    key: string;
    label: string;
    title: string;
    group: string;
    icon: LucideIcon;
    Panel: ComponentType<SettingsPanelProps>;
}

export const SETTINGS_SECTIONS = [
    {
        key: "cloud",
        label: "Cloud 概览",
        title: "Cloud 概览",
        group: "账户与 Cloud",
        icon: CloudIcon,
        Panel: CloudOverviewPanel,
    },
    {
        key: "sync-security",
        label: "同步与安全",
        title: "同步与安全",
        group: "账户与 Cloud",
        icon: LockKeyholeIcon,
        Panel: SyncSecurityPanel,
    },
    {
        key: "common",
        label: "通用",
        title: "通用",
        group: "应用",
        icon: SettingsIcon,
        Panel: CommonSettingsPanel,
    },
    {
        key: "editor",
        label: "编辑器",
        title: "编辑器",
        group: "应用",
        icon: CodeIcon,
        Panel: EditorSettingsPanel,
    },
    {
        key: "notification",
        label: "通知",
        title: "通知",
        group: "应用",
        icon: BellIcon,
        Panel: NotificationSettingsPanel,
    },
    {
        key: "about",
        label: "关于",
        title: "关于",
        group: "应用",
        icon: InfoIcon,
        Panel: AboutPanel,
    },
    {
        key: "ai-runtime",
        label: "运行时",
        title: "运行时",
        group: "AI 能力",
        icon: BrainCircuitIcon,
        Panel: AiRuntimePanel,
    },
    {
        key: "ai-preferences",
        label: "偏好设置",
        title: "AI 偏好设置",
        group: "AI 能力",
        icon: SlidersHorizontalIcon,
        Panel: AiPreferencesPanel,
    },
    {
        key: "provider",
        label: "供应商",
        title: "供应商",
        group: "AI 能力",
        icon: ServerIcon,
        Panel: ModelProviderPanel,
    },
    {
        key: "model",
        label: "模型",
        title: "模型",
        group: "AI 能力",
        icon: BoxIcon,
        Panel: ModelListPanel,
    },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "common";

export function isSettingsSection(value: string | null): value is SettingsSection {
    return SETTINGS_SECTIONS.some((section) => section.key === value);
}
