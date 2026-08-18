import { invoke } from "@tauri-apps/api/core";

import type { AuthSessionSnapshot } from "@/types/ipc";

export function getAuthSnapshot(): Promise<AuthSessionSnapshot> {
    return invoke<AuthSessionSnapshot>("get_auth_snapshot");
}

function normalizeAuthAvatarPayload(
    payload: unknown,
): Uint8Array<ArrayBuffer> {
    if (payload instanceof ArrayBuffer) {
        return new Uint8Array(payload.slice(0));
    }
    if (ArrayBuffer.isView(payload)) {
        return Uint8Array.from(
            new Uint8Array(
                payload.buffer,
                payload.byteOffset,
                payload.byteLength,
            ),
        );
    }
    if (
        Array.isArray(payload) &&
        payload.every(
            (value) =>
                Number.isInteger(value) && value >= 0 && value <= 255,
        )
    ) {
        return Uint8Array.from(payload as number[]);
    }
    throw new Error("Unexpected authentication avatar payload");
}

/**
 * 获取与公开 revision 精确对应的本地 PNG。
 *
 * Tauri 当前原始二进制 IPC 预期返回 ArrayBuffer；IPC 边界仍防御性接受
 * TypedArray 或字节数字数组，并统一复制成 Uint8Array，避免异常桥接结果被 Blob 编码成文本。
 * 空 Uint8Array 表示头像不可用，调用方应降级。
 */
export async function getAuthAvatar(
    revision: string,
): Promise<Uint8Array<ArrayBuffer>> {
    const payload = await invoke<unknown>("get_auth_avatar", { revision });
    return normalizeAuthAvatarPayload(payload);
}

export function startAuthSignIn(): Promise<AuthSessionSnapshot> {
    return invoke<AuthSessionSnapshot>("start_auth_sign_in");
}

export function cancelAuthSignIn(): Promise<AuthSessionSnapshot> {
    return invoke<AuthSessionSnapshot>("cancel_auth_sign_in");
}

export function retryAuthSession(): Promise<AuthSessionSnapshot> {
    return invoke<AuthSessionSnapshot>("retry_auth_session");
}

export function signOutAuthSession(): Promise<AuthSessionSnapshot> {
    return invoke<AuthSessionSnapshot>("sign_out_auth_session");
}
