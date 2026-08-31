import { useEffect, useState } from "react";

import { Loader2Icon } from "lucide-react";

import logoSvg from "@/assets/logo.svg";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { getCurrentReleaseNotes } from "@/features/release-notes/current-release-notes";
import { UpdatePrompt } from "@/features/update/UpdatePrompt";
import { useUpdateController } from "@/features/update/use-update-controller";

type ReleaseNotesState =
    | { status: "idle" | "loading" }
    | { status: "ready"; body: string }
    | { status: "error" };

function renderReleaseNotesMarkdown(markdown: string) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const blocks: Array<
        | { type: "heading"; text: string; level: number }
        | { type: "paragraph"; text: string }
        | { type: "list"; items: string[] }
    > = [];
    let listItems: string[] = [];

    const flushList = () => {
        if (listItems.length > 0) {
            blocks.push({ type: "list", items: listItems });
            listItems = [];
        }
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            flushList();
            continue;
        }

        if (trimmed.startsWith("- ")) {
            listItems.push(trimmed.slice(2));
            continue;
        }

        flushList();

        const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (heading) {
            blocks.push({
                type: "heading",
                level: heading[1].length,
                text: heading[2],
            });
            continue;
        }

        blocks.push({ type: "paragraph", text: trimmed });
    }

    flushList();

    return (
        <div className="space-y-3">
            {blocks.map((block, index) => {
                if (block.type === "heading") {
                    const className =
                        block.level <= 1
                            ? "text-sm font-semibold"
                            : "text-sm font-medium";

                    return (
                        <p key={`heading-${index}`} className={className}>
                            {block.text}
                        </p>
                    );
                }

                if (block.type === "list") {
                    return (
                        <ul
                            key={`list-${index}`}
                            className="list-disc space-y-1 pl-5 text-sm leading-6"
                        >
                            {block.items.map((item) => (
                                <li key={item}>{item}</li>
                            ))}
                        </ul>
                    );
                }

                return (
                    <p key={`paragraph-${index}`} className="text-sm leading-6">
                        {block.text}
                    </p>
                );
            })}
        </div>
    );
}

export function AboutPanel() {
    const { checkForUpdates, isCheckingUpdate } = useUpdateController();
    const [version, setVersion] = useState("加载中...");
    const [releaseNotesState, setReleaseNotesState] =
        useState<ReleaseNotesState>({ status: "idle" });

    useEffect(() => {
        let cancelled = false;

        async function loadVersionAndNotes() {
            setReleaseNotesState({ status: "loading" });

            try {
                const notes = await getCurrentReleaseNotes();
                if (cancelled) {
                    return;
                }

                setVersion(notes.version);
                setReleaseNotesState({ status: "ready", body: notes.body });
            } catch (error) {
                console.error("[release-notes] load failed:", error);
                if (!cancelled) {
                    setVersion("未知");
                    setReleaseNotesState({ status: "error" });
                }
            }
        }

        void loadVersionAndNotes();

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <img
                    src={logoSvg}
                    alt=""
                    className="size-10 shrink-0"
                    draggable={false}
                />
                <div>
                    <h3 className="font-medium">NexusPilot</h3>
                    <p className="text-xs text-muted-foreground">
                        下一代 AI 原生数据库工作台
                    </p>
                </div>
            </div>

            <Separator />

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                        版本
                    </span>
                    <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{version}</span>
                        <UpdatePrompt appearance="badge" />
                    </div>
                </div>
            </div>

            <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                    void checkForUpdates("manual");
                }}
                disabled={isCheckingUpdate}
            >
                {isCheckingUpdate ? (
                    <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : null}
                {isCheckingUpdate ? "检查中..." : "检查更新"}
            </Button>

            {/* TODO: 临时反馈渠道展示，后续反馈渠道正式打通后删除此区块 */}
            <div className="space-y-2">
                <p className="text-sm font-medium">反馈渠道 / 联系我们</p>
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                        邮箱
                    </span>
                    <span className="font-mono text-sm">support@nexuspilot.dev</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                        QQ 群
                    </span>
                    <span className="font-mono text-sm">1054453561</span>
                </div>
            </div>

            <Separator />

            <div className="space-y-2">
                <p className="text-sm font-medium">当前版本更新日志</p>
                {releaseNotesState.status === "ready" ? (
                    <ScrollArea className="h-52 rounded-md border bg-muted/30">
                        <div className="p-3 text-foreground/90">
                            {releaseNotesState.body.trim() ? (
                                renderReleaseNotesMarkdown(
                                    releaseNotesState.body,
                                )
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    此版本暂无发布日志。
                                </p>
                            )}
                        </div>
                    </ScrollArea>
                ) : releaseNotesState.status === "error" ? (
                    <p className="text-sm text-muted-foreground">
                        暂时无法获取此版本发布日志。
                    </p>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        正在获取当前版本发布日志...
                    </p>
                )}
            </div>
        </div>
    );
}
