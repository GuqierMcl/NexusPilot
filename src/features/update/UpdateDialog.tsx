import { useEffect, useMemo, useState } from "react";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { useUpdateController } from "./use-update-controller";

function formatReleaseDate(date?: string): string | null {
    if (!date) {
        return null;
    }

    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
        return date;
    }

    return parsedDate.toLocaleString("zh-CN");
}

export function UpdateDialog() {
    const {
        availableUpdate,
        availableUpdateInfo,
        isInstallingUpdate,
        isUpdateDialogOpen,
        lastError,
        closeUpdateDialog,
        installCurrentUpdate,
    } = useUpdateController();

    const [downloadedBytes, setDownloadedBytes] = useState(0);
    const [contentLength, setContentLength] = useState<number | null>(null);
    const updateVersion = availableUpdateInfo?.version;

    const releaseDate = useMemo(
        () => formatReleaseDate(availableUpdateInfo?.date),
        [availableUpdateInfo?.date],
    );

    const progress = useMemo(() => {
        if (!contentLength || contentLength <= 0) {
            return null;
        }

        return Math.min(100, Math.round((downloadedBytes / contentLength) * 100));
    }, [contentLength, downloadedBytes]);

    useEffect(() => {
        setDownloadedBytes(0);
        setContentLength(null);
    }, [updateVersion, isUpdateDialogOpen]);

    const handleOpenChange = (open: boolean) => {
        if (open) {
            return;
        }

        if (isInstallingUpdate) {
            return;
        }

        closeUpdateDialog();
    };

    const handleInstall = async () => {
        await installCurrentUpdate((event: DownloadEvent) => {
            if (event.event === "Started") {
                setContentLength(event.data.contentLength ?? null);
                setDownloadedBytes(0);
                return;
            }

            if (event.event === "Progress") {
                setDownloadedBytes((current) => current + event.data.chunkLength);
                return;
            }

            setDownloadedBytes(contentLength ?? 100);
        });
    };

    if (!availableUpdate || !availableUpdateInfo) {
        return null;
    }

    return (
        <Dialog open={isUpdateDialogOpen} onOpenChange={handleOpenChange}>
            <DialogContent
                className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-2xl"
                showCloseButton={false}
            >
                <DialogHeader>
                    <div className="flex flex-wrap items-center gap-2">
                        <DialogTitle>发现新版本</DialogTitle>
                        <Badge variant="secondary">
                            {availableUpdateInfo.version}
                        </Badge>
                    </div>
                    <DialogDescription className="text-sm text-muted-foreground">
                        当前版本 {availableUpdateInfo.currentVersion}
                        {releaseDate ? `，发布时间 ${releaseDate}` : ""}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-col gap-4">
                    <Separator />

                    <ScrollArea
                        type="auto"
                        className="max-h-64 min-h-0 rounded-md border bg-muted/30 [&>[data-slot=scroll-area-viewport]]:max-h-64"
                    >
                        <div className="flex flex-col gap-3 p-4">
                            <p className="text-sm font-semibold">更新日志</p>
                            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                                {availableUpdateInfo.body?.trim() ||
                                    "暂无更新日志。"}
                            </p>
                        </div>
                    </ScrollArea>

                    {progress != null && (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>下载进度</span>
                                <span>{progress}%</span>
                            </div>
                            <Progress value={progress} />
                        </div>
                    )}

                    {isInstallingUpdate && progress == null && (
                        <p className="text-sm text-muted-foreground">
                            正在下载安装更新，请稍候。
                        </p>
                    )}

                    {lastError && (
                        <p
                            className={cn(
                                "text-sm text-destructive",
                                isInstallingUpdate ? "animate-pulse" : "",
                            )}
                        >
                            {lastError}
                        </p>
                    )}
                </div>

                <DialogFooter className="gap-2 sm:justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={closeUpdateDialog}
                        disabled={isInstallingUpdate}
                    >
                        稍后
                    </Button>
                    <Button
                        type="button"
                        onClick={() => {
                            void handleInstall();
                        }}
                        disabled={isInstallingUpdate}
                    >
                        {isInstallingUpdate ? "正在更新..." : "立即更新"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
