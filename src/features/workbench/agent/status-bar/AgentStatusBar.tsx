"use client";

import { useEffect, useRef, useState } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  Plus,
  History,
  Pencil,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { isRuntimeConversationId } from "@/lib/ai-runtime/runtime-ids";
import type { AgentPanelBodyMode } from "../agent-panel-mode";
import { getAgentChatTitle, getAgentChatTitleFromMessages } from "../history";

interface AgentStatusBarProps {
  bodyMode: AgentPanelBodyMode;
  onChatRequested: () => void;
  onHistoryToggle: () => void;
  onSettingsRequested?: () => void;
}

export function AgentStatusBar({
  bodyMode,
  onChatRequested,
  onHistoryToggle,
  onSettingsRequested,
}: AgentStatusBarProps) {
  const aui = useAui();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const currentThreadItem = useAuiState((state) => state.threadListItem);
  const currentThreadTitle = useAuiState((state) =>
    getAgentChatTitle(state.threadListItem),
  );
  const currentThreadMessages = useAuiState((state) => state.thread.messages);
  const chatTitle =
    currentThreadTitle || getAgentChatTitleFromMessages(currentThreadMessages);
  const currentThreadId = currentThreadItem?.id;
  const canRenameCurrentThread =
    Boolean(currentThreadId) && isRuntimeConversationId(currentThreadItem?.remoteId);

  useEffect(() => {
    if (!renaming) {
      return;
    }

    setRenameValue(chatTitle);
    queueMicrotask(() => inputRef.current?.select());
  }, [chatTitle, renaming]);

  const cancelRename = () => {
    setRenaming(false);
    setRenameValue("");
  };

  const saveRename = async () => {
    if (!canRenameCurrentThread || !currentThreadId) {
      cancelRename();
      return;
    }

    const title = renameValue.trim();
    if (!title) {
      toast.error("对话名称不能为空");
      return;
    }

    if (title === chatTitle) {
      cancelRename();
      return;
    }

    await aui.threads().item({ id: currentThreadId }).rename(title);
    await aui.threads().reload();
    cancelRename();
  };

  return (
    <div className="flex shrink-0 flex-col border-b">
      <div className="flex h-10 items-center gap-1 px-2">
        <Button
          size="icon"
          variant="ghost"
          title="新对话"
          aria-label="新对话"
          className="size-7"
          onClick={() => {
            void aui.threads().switchToNewThread();
            onChatRequested();
          }}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant={bodyMode === "history" ? "secondary" : "ghost"}
          title={bodyMode === "history" ? "返回对话" : "历史对话"}
          aria-label={bodyMode === "history" ? "返回对话" : "历史对话"}
          className="size-7"
          onClick={onHistoryToggle}
        >
          <History className="size-3.5" />
        </Button>

        <Separator orientation="vertical" className="mx-1 my-2" />

        <div className="flex min-w-0 flex-1 items-center justify-center">
          {renaming ? (
            <Input
              ref={inputRef}
              value={renameValue}
              className="h-7 max-w-full text-center text-xs"
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => {
                void saveRename();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveRename();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          ) : (
            <span className="truncate text-xs text-muted-foreground">
              {bodyMode === "history" ? "历史对话" : chatTitle}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            title="重命名对话"
            aria-label="重命名对话"
            className="size-7"
            disabled={bodyMode === "history" || !canRenameCurrentThread}
            onClick={() => setRenaming(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="AI 设置"
            aria-label="AI 设置"
            className="size-7"
            onClick={onSettingsRequested}
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
