import type { FC } from "react";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface AiRuntimeVersionMismatch {
    appVersion: string;
    runtimeVersion: string;
}

interface AiRuntimeVersionMismatchAlertProps
    extends AiRuntimeVersionMismatch {
    onOpenDownload: () => void;
}

export function getAiRuntimeVersionMismatch(
    appVersion: string | null | undefined,
    runtimeVersion: string | null,
): AiRuntimeVersionMismatch | null {
    if (!appVersion || !runtimeVersion || appVersion === runtimeVersion) {
        return null;
    }

    return { appVersion, runtimeVersion };
}

export const AiRuntimeVersionMismatchAlert: FC<
    AiRuntimeVersionMismatchAlertProps
> = ({ appVersion, runtimeVersion, onOpenDownload }) => (
    <Alert
        variant="destructive"
        className="border-destructive/40 bg-destructive/5 dark:bg-destructive/10"
    >
        <TriangleAlertIcon />
        <AlertTitle>AI Runtime 版本不匹配</AlertTitle>
        <AlertDescription>
            当前 NexusPilot 版本为 {appVersion}，AI Runtime 版本为 {runtimeVersion}。
            这可能导致部分 AI 功能无法正常使用。请前往官网下载并重新安装最新版
            NexusPilot，以更新配套的 AI Runtime。
        </AlertDescription>
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="col-start-2 mt-3 w-fit"
            onClick={onOpenDownload}
        >
            <ExternalLinkIcon data-icon="inline-start" />
            前往官网下载
        </Button>
    </Alert>
);
