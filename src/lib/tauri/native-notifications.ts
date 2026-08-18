import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";

export interface NativeNotificationInput {
    title: string;
    body?: string;
}

/**
 * 主动请求系统通知授权。应由设置项等明确的用户操作触发，而非在应用启动时调用。
 */
export async function requestNativeNotificationPermission(): Promise<boolean> {
    if (await isPermissionGranted()) {
        return true;
    }

    return (await requestPermission()) === "granted";
}

/**
 * 仅当主窗口失焦且系统通知已经获授权时，发送原生通知。
 */
export async function sendBackgroundNativeNotification(
    input: NativeNotificationInput,
): Promise<boolean> {
    if (!(await canSendBackgroundNativeNotification())) {
        return false;
    }

    sendNotification(input);
    return true;
}

export async function canSendBackgroundNativeNotification(): Promise<boolean> {
    return !(await isApplicationWindowFocused()) && (await isPermissionGranted());
}

async function isApplicationWindowFocused(): Promise<boolean> {
    try {
        return await getCurrentWindow().isFocused();
    } catch {
        return typeof document !== "undefined" && document.hasFocus();
    }
}
