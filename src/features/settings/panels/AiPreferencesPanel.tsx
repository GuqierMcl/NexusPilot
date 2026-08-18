import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsSection } from "@/features/settings/components/settings-section";
import {
    getRuntimeSettings,
    updateRuntimeSettings,
    type AutoApproveMaxRisk,
    type NetworkAccessScope,
} from "@/lib/ai-runtime/settings";
import { queryKeys } from "@/lib/query-keys";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import { useSettingsStore } from "@/store/slices/settings-slice";
import type {
    AiConversationRendering,
    AiConversationStartupOption,
} from "@/types/settings";
import { AiRuntimeSettingsGate } from "./AiRuntimeSettingsGate";

const AUTO_APPROVAL_RISK_OPTIONS: Array<{
    value: AutoApproveMaxRisk;
    label: string;
}> = [
    { value: "none", label: "不自动执行" },
    { value: "low", label: "低风险（默认）" },
    { value: "medium", label: "中风险及以下" },
];

const NETWORK_ACCESS_SCOPE_OPTIONS: Array<{
    value: NetworkAccessScope;
    label: string;
}> = [
    { value: "local-and-public", label: "本地网络与公网（默认）" },
    { value: "public-only", label: "仅公网" },
];

const STARTUP_CONVERSATION_OPTIONS: Array<{
    value: AiConversationStartupOption;
    label: string;
}> = [
    { value: "new", label: "新对话" },
    { value: "restore-last", label: "上一次打开的对话" },
];

function ToolApprovalSettingsSection() {
    const queryClient = useQueryClient();
    const isAiRuntimeHealthy = useAiRuntimeEndpointStore(
        (state) => state.healthStatus === "healthy",
    );
    const settingsQuery = useQuery({
        queryKey: queryKeys.aiRuntimeSettings(),
        queryFn: ({ signal }) => getRuntimeSettings(signal),
        enabled: isAiRuntimeHealthy,
    });
    const policyMutation = useMutation({
        mutationFn: updateRuntimeSettings,
        onSuccess: (settings) => {
            queryClient.setQueryData(
                queryKeys.aiRuntimeSettings(),
                settings,
            );
            toast.success("工具审批策略已更新");
        },
    });
    const networkPolicyMutation = useMutation({
        mutationFn: updateRuntimeSettings,
        onSuccess: (settings) => {
            queryClient.setQueryData(
                queryKeys.aiRuntimeSettings(),
                settings,
            );
            toast.success("网络访问范围已更新");
        },
    });
    const currentThreshold =
        settingsQuery.data?.toolPolicy.autoApproveMaxRisk;
    const currentNetworkAccessScope =
        settingsQuery.data?.networkPolicy.accessScope;

    const content = (
        <>
        <SettingsSection
            title="工具审批"
            description="控制新运行中低风险工具的自动执行范围。"
        >
            <FieldGroup>
                <Field>
                    <FieldLabel htmlFor="ai-tool-auto-approval-select">
                        自动审批最高风险
                    </FieldLabel>
                    <Select
                        modal={false}
                        value={currentThreshold ?? ""}
                        items={AUTO_APPROVAL_RISK_OPTIONS}
                        disabled={
                            settingsQuery.isLoading ||
                            settingsQuery.isError ||
                            policyMutation.isPending
                        }
                        onValueChange={(value) => {
                            if (!settingsQuery.data) return;
                            policyMutation.mutate({
                                ...settingsQuery.data,
                                toolPolicy: {
                                    autoApproveMaxRisk:
                                        value as AutoApproveMaxRisk,
                                },
                            });
                        }}
                    >
                        <SelectTrigger
                            id="ai-tool-auto-approval-select"
                            className="w-full"
                        >
                            <SelectValue placeholder="正在读取 Runtime 设置" />
                        </SelectTrigger>
                        <SelectContent>
                            {AUTO_APPROVAL_RISK_OPTIONS.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <FieldDescription>
                        仅影响之后创建的新运行。高风险和严重风险工具始终需要审批；严重风险始终要求强确认。本设置不会创建永久授权。
                    </FieldDescription>
                </Field>
            </FieldGroup>
        </SettingsSection>
        <SettingsSection
            title="网络访问范围"
            description="控制新运行中 Web 读取与网络诊断工具可访问的目标范围。"
        >
            <FieldGroup>
                <Field>
                    <FieldLabel htmlFor="ai-network-access-scope-select">
                        网络访问范围
                    </FieldLabel>
                    <Select
                        modal={false}
                        value={currentNetworkAccessScope ?? ""}
                        items={NETWORK_ACCESS_SCOPE_OPTIONS}
                        disabled={
                            settingsQuery.isLoading ||
                            settingsQuery.isError ||
                            networkPolicyMutation.isPending
                        }
                        onValueChange={(value) => {
                            if (!settingsQuery.data) return;
                            networkPolicyMutation.mutate({
                                ...settingsQuery.data,
                                networkPolicy: {
                                    accessScope:
                                        value as NetworkAccessScope,
                                },
                            });
                        }}
                    >
                        <SelectTrigger
                            id="ai-network-access-scope-select"
                            className="w-full"
                        >
                            <SelectValue placeholder="正在读取 Runtime 设置" />
                        </SelectTrigger>
                        <SelectContent>
                            {NETWORK_ACCESS_SCOPE_OPTIONS.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <FieldDescription>
                        本地网络与公网允许访问当前设备可达的内网、VPN、容器服务和 localhost；仅公网会阻止 Web 工具访问本地与私有网络。仅影响之后创建的新运行。
                    </FieldDescription>
                </Field>
            </FieldGroup>
        </SettingsSection>
        </>
    );

    return (
        <AiRuntimeSettingsGate
            className="min-h-0"
            preview={content}
        >
            {content}
        </AiRuntimeSettingsGate>
    );
}

export function AiPreferencesPanel() {
    const {
        ai,
        setAiBackgroundNotifications,
        setAiConversationRendering,
        setAiConversationStartupOption,
        setAiNotifyOnFailure,
        setAiShowReplyPreview,
    } = useSettingsStore();

    return (
        <div className="flex flex-col gap-6">
            <ToolApprovalSettingsSection />

            <SettingsSection title="启动">
                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor="ai-startup-conversation-select">
                            启动时打开
                        </FieldLabel>
                        <Select
                            modal={false}
                            value={ai.startupConversation}
                            items={STARTUP_CONVERSATION_OPTIONS}
                            onValueChange={(value) => {
                                setAiConversationStartupOption(
                                    value as AiConversationStartupOption,
                                );
                            }}
                        >
                            <SelectTrigger
                                id="ai-startup-conversation-select"
                                className="w-full"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                            {STARTUP_CONVERSATION_OPTIONS.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            如果上一次对话已被删除或归档，将自动打开新对话。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>

            <SettingsSection title="对话渲染">
                <FieldGroup>
                    <Field>
                        <FieldLabel>渲染模式</FieldLabel>
                        <Tabs
                            value={ai.conversationRendering}
                            onValueChange={(value) => {
                                setAiConversationRendering(
                                    value as AiConversationRendering,
                                );
                            }}
                        >
                            <TabsList className="w-full">
                                <TabsTrigger value="standard" className="flex-1">
                                    普通模式
                                </TabsTrigger>
                                <TabsTrigger value="virtualized" className="flex-1">
                                    虚拟列表
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                        <FieldDescription>
                            虚拟列表适合包含大量消息的长对话；生成中更改会在本轮完成后生效。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>

            <SettingsSection title="智能体通知">
                <FieldGroup>
                    <Field className="flex flex-row items-center justify-between">
                        <div className="space-y-0.5">
                            <FieldLabel>智能体后台通知</FieldLabel>
                            <FieldDescription>
                                当 NexusPilot 未获得焦点时，智能体完成回复或等待审核会显示系统通知。
                            </FieldDescription>
                        </div>
                        <Switch
                            checked={ai.backgroundNotifications}
                            onCheckedChange={setAiBackgroundNotifications}
                        />
                    </Field>
                    <Field className="flex flex-row items-center justify-between">
                        <div className="space-y-0.5">
                            <FieldLabel>显示回复预览</FieldLabel>
                            <FieldDescription>
                                在完成通知中显示当前回复前 80 个字符；关闭后仅显示完成提示。
                            </FieldDescription>
                        </div>
                        <Switch
                            checked={ai.showReplyPreview}
                            disabled={!ai.backgroundNotifications}
                            onCheckedChange={setAiShowReplyPreview}
                        />
                    </Field>
                    <Field className="flex flex-row items-center justify-between">
                        <div className="space-y-0.5">
                            <FieldLabel>执行失败时通知</FieldLabel>
                            <FieldDescription>
                                默认关闭，避免临时网络或模型错误造成额外打扰。
                            </FieldDescription>
                        </div>
                        <Switch
                            checked={ai.notifyOnFailure}
                            disabled={!ai.backgroundNotifications}
                            onCheckedChange={setAiNotifyOnFailure}
                        />
                    </Field>
                </FieldGroup>
            </SettingsSection>
        </div>
    );
}
