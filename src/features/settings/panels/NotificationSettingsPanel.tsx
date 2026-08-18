import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/features/settings/components/settings-section";
import { requestNativeNotificationPermission } from "@/lib/tauri/native-notifications";
import { useSettingsStore } from "@/store/slices/settings-slice";
const TOAST_DURATION_OPTIONS: { value: number; label: string }[] = [
    { value: 3000, label: "3 秒" },
    { value: 4000, label: "4 秒" },
    { value: 5000, label: "5 秒" },
    { value: 10000, label: "10 秒" },
    { value: Infinity, label: "永不" },
];

const TOAST_VISIBLE_OPTIONS: { value: number; label: string }[] = [
    { value: 3, label: "3 条" },
    { value: 5, label: "5 条" },
    { value: 10, label: "10 条" },
];

export function NotificationSettingsPanel() {
    const {
        notification,
        setNotificationDuration,
        setNotificationVisibleToasts,
        setSystemNotificationsEnabled,
    } = useSettingsStore();

    const handleDurationChange = (value: string | null) => {
        if (value == null) return;
        setNotificationDuration(Number(value));
    };

    const handleVisibleToastsChange = (value: string | null) => {
        if (value == null) return;
        setNotificationVisibleToasts(Number(value));
    };

    const handleTestNotification = () => {
        toast.success("测试通知", {
            description: "通知位置已更新，当前设置已生效。",
        });
    };

    const handleSystemNotificationPermission = () => {
        void requestNativeNotificationPermission()
            .then((granted) => {
                if (granted) {
                    toast.success("系统通知已授权");
                    return;
                }

                toast.info("系统通知尚未获得授权");
            })
            .catch((error: unknown) => {
                console.error(
                    "[NotificationSettingsPanel] notification permission failed",
                    error,
                );
                toast.error("无法请求系统通知授权");
            });
    };

    return (
        <div className="flex flex-col gap-6">
            <SettingsSection title="应用内通知">
                <FieldGroup>
                    <Field>
                        <FieldLabel>应用内通知</FieldLabel>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleTestNotification}
                        >
                            测试通知
                        </Button>
                        <FieldDescription>
                            通知固定显示在应用窗口右下角。
                        </FieldDescription>
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="toast-duration-select">
                            自动关闭时长
                        </FieldLabel>
                        <Select
                            modal={false}
                            value={String(notification.duration)}
                            items={TOAST_DURATION_OPTIONS.map((option) => ({
                                value: String(option.value),
                                label: option.label,
                            }))}
                            onValueChange={handleDurationChange}
                        >
                            <SelectTrigger
                                id="toast-duration-select"
                                className="w-full"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {TOAST_DURATION_OPTIONS.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={String(option.value)}
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            通知将在设定时间后自动关闭，选择"永不"需手动关闭。
                        </FieldDescription>
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="toast-visible-select">
                            最大可见数量
                        </FieldLabel>
                        <Select
                            modal={false}
                            value={String(notification.visibleToasts)}
                            items={TOAST_VISIBLE_OPTIONS.map((option) => ({
                                value: String(option.value),
                                label: option.label,
                            }))}
                            onValueChange={handleVisibleToastsChange}
                        >
                            <SelectTrigger
                                id="toast-visible-select"
                                className="w-full"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {TOAST_VISIBLE_OPTIONS.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={String(option.value)}
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            同时显示的最大通知数量，超出部分将被折叠。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>

            <SettingsSection title="系统通知">
                <FieldGroup>
                    <Field className="flex flex-row items-center justify-between">
                        <div className="space-y-0.5">
                            <FieldLabel>启用系统通知</FieldLabel>
                            <FieldDescription>
                                关闭后，NexusPilot 不会再发送系统通知。
                            </FieldDescription>
                        </div>
                        <Switch
                            checked={notification.systemNotificationsEnabled}
                            onCheckedChange={setSystemNotificationsEnabled}
                        />
                    </Field>
                    <Field>
                        <FieldLabel>系统通知授权</FieldLabel>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={handleSystemNotificationPermission}
                        >
                            检查并请求授权
                        </Button>
                        <FieldDescription>
                            首次使用前请允许操作系统发送通知；各模块的具体提醒规则在各自偏好设置中管理。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>
        </div>
    );
}
