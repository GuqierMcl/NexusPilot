import { useEffect, useState } from "react";

import { getAuthAvatar } from "@/features/account/auth-client";
import type { AuthUser } from "@/types/ipc";

/**
 * 头像始终来自 Rust 本地净化缓存。失败是纯展示降级，不进入认证错误状态。
 */
export function useAuthAvatar(user: AuthUser | null): string | null {
    const [source, setSource] = useState<string | null>(null);
    const revision = user?.avatarRevision ?? null;
    const providerId = user?.providerId ?? null;
    const issuer = user?.issuer ?? null;
    const subject = user?.subject ?? null;

    useEffect(() => {
        let active = true;
        let objectUrl: string | null = null;
        setSource(null);

        if (!revision || !providerId || !issuer || !subject) {
            return () => {
                active = false;
            };
        }

        void getAuthAvatar(revision)
            .then((bytes) => {
                if (!active || bytes.byteLength === 0) {
                    return;
                }
                objectUrl = URL.createObjectURL(
                    new Blob([bytes], { type: "image/png" }),
                );
                setSource(objectUrl);
            })
            .catch(() => {
                // 可选头像读取失败只保留首字母，不污染认证状态或日志。
            });

        return () => {
            active = false;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [issuer, providerId, revision, subject]);

    return source;
}
