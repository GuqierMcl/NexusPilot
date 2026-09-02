import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningText,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { DotMatrix } from "@/components/dot-matrix";
import { ChainOfThought } from "@/components/assistant-ui/chain-of-thought";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { getRuntimeMessageStatusView } from "@/features/workbench/agent/state";
import { cn } from "@/lib/utils";
import { pickThreadWelcomeMessage } from "@/components/assistant-ui/thread-welcome-messages";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
  unstable_useThreadMessageIds,
} from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SquareIcon,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  AssistantMessageStatus?: ComponentType | undefined;
  ComposerCancelAction?: ComponentType | undefined;
  ComposerFooterStart?: ComponentType | undefined;
  ComposerFooterStatus?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadVariant = "default" | "workbench";

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  variant?: ThreadVariant | undefined;
  onUserMessageEditStart?: ((messageId: string) => void) | undefined;
  onUserMessageEditCancel?: (() => void) | undefined;
};

type ThreadEditCallbacks = Pick<
  ThreadProps,
  "onUserMessageEditStart" | "onUserMessageEditCancel"
>;

const EMPTY_COMPONENTS: ThreadComponents = {};
const EMPTY_THREAD_EDIT_CALLBACKS: ThreadEditCallbacks = {};
const ESTIMATED_TURN_HEIGHT = 220;
const AT_BOTTOM_THRESHOLD = 4;

async function exportAssistantMessageMarkdown(content: string): Promise<void> {
  try {
    const destinationPath = await save({
      title: "导出 Markdown",
      defaultPath: `nexuspilot-message-${Date.now()}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destinationPath) return;

    await writeFile(destinationPath, new TextEncoder().encode(content));
    toast.success("Markdown 已导出");
  } catch (error) {
    console.error("[assistant-ui] failed to export Markdown", error);
    toast.error("Markdown 导出失败，可重试");
  }
}

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);
const ThreadEditCallbacksContext = createContext<ThreadEditCallbacks>(
  EMPTY_THREAD_EDIT_CALLBACKS,
);

// Startup exposes a loading placeholder thread; treat it as an empty thread so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

const WORKBENCH_TYPOGRAPHY_CLASS_NAME = [
  "text-sm",
  "[&_.aui-md-h1]:mt-4 [&_.aui-md-h1]:mb-1.5 [&_.aui-md-h1]:text-base [&_.aui-md-h1]:leading-6",
  "[&_.aui-md-h2]:mt-4 [&_.aui-md-h2]:mb-1.5 [&_.aui-md-h2]:text-sm [&_.aui-md-h2]:leading-5",
  "[&_.aui-md-h3]:mt-3 [&_.aui-md-h3]:mb-1 [&_.aui-md-h3]:text-sm [&_.aui-md-h3]:leading-5",
  "[&_.aui-md-h4]:text-sm [&_.aui-md-h5]:text-xs [&_.aui-md-h6]:text-xs",
  "[&_.aui-md-p]:my-2 [&_.aui-md-ul]:my-2 [&_.aui-md-ol]:my-2 [&_.aui-md-table]:my-2",
  "[&_.aui-md-pre]:p-2.5 [&_.aui-md-pre]:text-xs",
  "[&_.aui-code-header-root]:px-2.5 [&_.aui-code-header-root]:py-1 [&_.aui-code-header-root]:text-[11px]",
  "[&_.aui-shiki-base_pre]:p-2.5 [&_.aui-shiki-base_pre]:text-xs",
  "[&_.aui-reasoning-trigger]:text-xs [&_.aui-reasoning-content]:text-xs",
  "[&_.aui-tool-group-trigger]:text-xs [&_.aui-tool-group-content]:text-xs",
  "[&_.aui-tool-fallback-trigger]:text-xs [&_.aui-tool-fallback-content]:text-xs",
  "[&_.aui-tool-fallback-args-value]:text-[11px] [&_.aui-tool-fallback-result-content]:text-[11px]",
].join(" ");

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  variant = "default",
  onUserMessageEditStart,
  onUserMessageEditCancel,
}) => {
  const isEmpty = useAuiState(isNewChatView);
  const editCallbacks = useMemo<ThreadEditCallbacks>(
    () => ({ onUserMessageEditStart, onUserMessageEditCancel }),
    [onUserMessageEditCancel, onUserMessageEditStart],
  );

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadEditCallbacksContext.Provider value={editCallbacks}>
        <ThreadRoot isEmpty={isEmpty} variant={variant} />
      </ThreadEditCallbacksContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

/**
 * Experimental virtualized thread for the workbench agent panel. It renders
 * only the turns close to the viewport while retaining the same message UI as
 * `Thread`. The scroll container is intentionally owned here because the
 * built-in viewport auto-scroll assumes every message is mounted.
 */
export const VirtualizedThread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  variant = "default",
  onUserMessageEditStart,
  onUserMessageEditCancel,
}) => {
  const isEmpty = useAuiState(isNewChatView);
  const editCallbacks = useMemo<ThreadEditCallbacks>(
    () => ({ onUserMessageEditStart, onUserMessageEditCancel }),
    [onUserMessageEditCancel, onUserMessageEditStart],
  );

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadEditCallbacksContext.Provider value={editCallbacks}>
        <VirtualizedThreadRoot isEmpty={isEmpty} variant={variant} />
      </ThreadEditCallbacksContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

type VirtualizedMessageRow = {
  id: string;
  role: "user" | "assistant" | "system";
};

type VirtualizedTurn = {
  id: string;
  messageIds: readonly string[];
};

const useVirtualizedMessageRows = (): readonly VirtualizedMessageRow[] => {
  const previousRowsRef = useRef<readonly VirtualizedMessageRow[]>([]);
  const messageIds = unstable_useThreadMessageIds();

  return useAuiState((state) => {
    const previousRows = previousRowsRef.current;
    if (
      previousRows.length === messageIds.length &&
      previousRows.every(
        (row, index) =>
          row.id === messageIds[index] &&
          row.role === state.thread.messages[index]?.role,
      )
    ) {
      return previousRows;
    }

    const nextRows = state.thread.messages.map(({ id, role }) => ({ id, role }));
    previousRowsRef.current = nextRows;
    return nextRows;
  });
};

function buildVirtualizedTurns(
  rows: readonly VirtualizedMessageRow[],
): readonly VirtualizedTurn[] {
  const turns: VirtualizedTurn[] = [];

  for (const row of rows) {
    const previousTurn = turns.at(-1);
    if (row.role === "user" || !previousTurn) {
      turns.push({ id: row.id, messageIds: [row.id] });
      continue;
    }

    previousTurn.messageIds = [...previousTurn.messageIds, row.id];
  }

  return turns;
}

const VirtualizedThreadRoot: FC<{
  isEmpty: boolean;
  variant: ThreadVariant;
}> = ({ isEmpty, variant }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  const isWorkbench = variant === "workbench";
  const rows = useVirtualizedMessageRows();
  const turns = useMemo(() => buildVirtualizedTurns(rows), [rows]);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const threadId = useAuiState((state) => state.threadListItem.id);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyToBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => turns[index]?.id ?? index,
    getScrollElement: () => scrollerRef.current,
    initialRect: { height: 800, width: 800 },
    overscan: 4,
    scrollToFn: (offset, _options, instance) => {
      const scroller = instance.scrollElement;
      if (!scroller) return;

      if (stickyToBottomRef.current) {
        const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
        if (
          maxScrollTop - scroller.scrollTop <= AT_BOTTOM_THRESHOLD &&
          offset < maxScrollTop
        ) {
          return;
        }
      }

      scroller.scrollTo({ top: offset });
    },
  });

  const jumpToBottom = useCallback(() => {
    stickyToBottomRef.current = true;
    if (turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    }

    requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller && stickyToBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        setIsAtBottom(true);
      }
    });
  }, [turns.length, virtualizer]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let previousScrollTop = scroller.scrollTop;
    let previousScrollHeight = scroller.scrollHeight;
    let previousClientHeight = scroller.clientHeight;

    const onScroll = () => {
      const atBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
        AT_BOTTOM_THRESHOLD;
      if (atBottom) {
        stickyToBottomRef.current = true;
      } else if (
        scroller.scrollTop < previousScrollTop &&
        scroller.scrollHeight === previousScrollHeight &&
        Math.abs(scroller.clientHeight - previousClientHeight) <= 1
      ) {
        stickyToBottomRef.current = false;
      }

      previousScrollTop = scroller.scrollTop;
      previousScrollHeight = scroller.scrollHeight;
      previousClientHeight = scroller.clientHeight;
      setIsAtBottom(atBottom);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickyToBottomRef.current = false;
    };
    const disarmAutoFollow = () => {
      stickyToBottomRef.current = false;
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchmove", disarmAutoFollow, {
      passive: true,
    });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchmove", disarmAutoFollow);
    };
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    const observer = new ResizeObserver(() => {
      if (stickyToBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const previousIsRunningRef = useRef(false);
  useLayoutEffect(() => {
    if (isRunning && !previousIsRunningRef.current) {
      jumpToBottom();
    }
    previousIsRunningRef.current = isRunning;
  }, [isRunning, jumpToBottom]);

  const initialJumpThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (turns.length === 0 || initialJumpThreadIdRef.current === threadId) {
      return;
    }
    initialJumpThreadIdRef.current = threadId;
    jumpToBottom();
  }, [threadId, turns.length, jumpToBottom]);

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0),
  );

  return (
    <ThreadPrimitive.Root
      data-variant={variant}
      className={cn(
        "aui-root aui-thread-root bg-background @container flex h-full flex-col",
        isWorkbench && WORKBENCH_TYPOGRAPHY_CLASS_NAME,
      )}
      style={{
        ["--thread-max-width" as string]: isWorkbench ? "100%" : "44rem",
        ["--composer-padding" as string]: isWorkbench ? "6px" : "8px",
      }}
    >
      <div
        ref={scrollerRef}
        data-slot="aui_virtualized-thread-viewport"
        className="scrollbar-shadcn relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        <div
          ref={contentRef}
          className={cn(
            "mx-auto flex min-h-full w-full max-w-(--thread-max-width) flex-col",
            isWorkbench ? "px-3 pt-3" : "px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          {isEmpty ? (
            <>
              <Welcome />
              <Composer variant={variant} />
            </>
          ) : null}
          {!isEmpty ? (
            <div
              data-slot="aui_virtualized-message-group"
              className="flex flex-col"
              style={{ paddingTop, paddingBottom }}
            >
              {virtualItems.map((virtualItem) => {
                const turn = turns[virtualItem.index];
                if (!turn) return null;

                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className={cn(
                      "flex flex-col",
                      isWorkbench ? "gap-y-4 pb-4" : "gap-y-6 pb-6",
                    )}
                  >
                    {turn.messageIds.map((messageId) => (
                      <ThreadPrimitive.Unstable_MessageById
                        key={messageId}
                        messageId={messageId}
                        components={VIRTUALIZED_MESSAGE_COMPONENTS}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {!isEmpty ? (
        <div
          className={cn(
            "aui-thread-virtualized-footer bg-background relative flex flex-col",
            isWorkbench ? "gap-2 px-3 pb-2" : "gap-4 px-4 pb-4 md:pb-6",
          )}
        >
          <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col">
            <VirtualizedScrollToBottom
              visible={!isAtBottom}
              onClick={jumpToBottom}
            />
            <Composer variant={variant} />
          </div>
        </div>
      ) : null}
    </ThreadPrimitive.Root>
  );
};

const VirtualizedScrollToBottom: FC<{
  visible: boolean;
  onClick: () => void;
}> = ({ visible, onClick }) => {
  if (!visible) return null;

  return (
    <TooltipIconButton
      tooltip="滚动到底部"
      variant="outline"
      onClick={onClick}
      className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4"
    >
      <ArrowDownIcon />
    </TooltipIconButton>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; variant: ThreadVariant }> = ({
  isEmpty,
  variant,
}) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  const isWorkbench = variant === "workbench";

  return (
    <ThreadPrimitive.Root
      data-variant={variant}
      className={cn(
        "aui-root aui-thread-root bg-background @container flex h-full flex-col",
        isWorkbench && WORKBENCH_TYPOGRAPHY_CLASS_NAME,
      )}
      style={{
        ["--thread-max-width" as string]: isWorkbench ? "100%" : "44rem",
        ["--composer-padding" as string]: isWorkbench ? "6px" : "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="scrollbar-shadcn relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col",
            isWorkbench ? "px-3 pt-3" : "px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className={cn(
              "flex flex-col empty:hidden",
              isWorkbench ? "mb-10 gap-y-4" : "mb-14 gap-y-6",
            )}
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col overflow-visible",
              isWorkbench ? "gap-2 pb-2" : "gap-4 pb-4 md:pb-6",
              !isEmpty && "sticky bottom-0 mt-auto rounded-t-xl",
            )}
          >
            <ThreadScrollToBottom />
            <Composer variant={variant} />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const VIRTUALIZED_MESSAGE_COMPONENTS = {
  Message: ThreadMessage,
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="滚动到底部"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const [welcomeMessage] = useState(pickThreadWelcomeMessage);

  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        {welcomeMessage}
      </h1>
    </div>
  );
};

const Composer: FC<{ variant: ThreadVariant }> = ({ variant }) => {
  const isWorkbench = variant === "workbench";

  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className={cn(
            "bg-background border-border/60 data-[dragging=true]:border-ring data-[dragging=true]:bg-accent/50 focus-within:border-border dark:border-muted-foreground/15 dark:bg-muted/30 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 border p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed dark:shadow-none",
            isWorkbench ? "rounded-xl" : "rounded-3xl",
          )}
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="尽管说，什么都可以..."
            className={cn(
              "aui-composer-input placeholder:text-muted-foreground/80 w-full resize-none bg-transparent outline-none",
              isWorkbench
                ? "max-h-28 min-h-8 px-2 py-1 text-sm"
                : "max-h-32 min-h-10 px-2.5 py-1 text-base",
            )}
            rows={1}
            autoFocus
            aria-label="消息输入"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  const { ComposerCancelAction, ComposerFooterStart, ComposerFooterStatus } =
    useContext(ThreadComponentsContext);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <ComposerAddAttachment />
        {ComposerFooterStart ? <ComposerFooterStart /> : null}
      </div>
      {ComposerFooterStatus ? (
        <div className="min-w-0 flex-1 text-center">
          <ComposerFooterStatus />
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="语音输入"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate size-7 rounded-full"
                aria-label="开始语音输入"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="停止语音输入"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="停止语音输入"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="发送"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="发送消息"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          {ComposerCancelAction ? (
            <ComposerCancelAction />
          ) : (
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-cancel size-7 rounded-full"
                aria-label="停止生成"
              >
                <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
              </Button>
            </ComposerPrimitive.Cancel>
          )}
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    AssistantMessageStatus,
  } = useContext(ThreadComponentsContext);
  const messageMetadata = useAuiState((state) => state.message.metadata);
  const runtimeMessageStatus = getRuntimeMessageStatusView(messageMetadata);

  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-foreground px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return (
                  <ExecutionProcess
                    group={part}
                    status={
                      part.status.type === "running"
                        ? "running"
                        : (runtimeMessageStatus?.kind ?? "complete")
                    }
                  >
                    {children}
                  </ExecutionProcess>
                );
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ApprovalAwareToolGroup group={part}>
                    {children}
                  </ApprovalAwareToolGroup>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                return (
                  <div
                    data-slot="aui-reasoning-summary-group"
                    className="py-1 text-muted-foreground"
                    aria-busy={part.status.type === "running"}
                  >
                    <ReasoningText className="ps-0 py-1 text-sm">
                      {children}
                    </ReasoningText>
                  </div>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <ConversationActivityIndicator />
        <MessageError />
        {AssistantMessageStatus ? <AssistantMessageStatus /> : null}
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const ApprovalAwareToolGroup: FC<
  PropsWithChildren<{ group: ThreadGroupPart }>
> = ({ children, group }) => {
  const pendingApprovalKey = usePendingApprovalKey(group.indices);
  const [open, setOpen] = useState(Boolean(pendingApprovalKey));

  useEffect(() => {
    if (pendingApprovalKey) {
      setOpen(true);
    }
  }, [pendingApprovalKey]);

  return (
    <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger
        count={group.indices.length}
        active={group.status.type === "running"}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const ExecutionProcess: FC<
  PropsWithChildren<{
    group: ThreadGroupPart;
    status: "running" | "complete" | "interrupted" | "failed";
  }>
> = ({ children, group, status }) => {
  const lastPartIndex = group.indices.at(-1);
  const pendingApprovalKey = usePendingApprovalKey(group.indices);
  const keepOpen = useAuiState((state) => {
    if (!state.thread.isRunning || lastPartIndex === undefined) return false;

    return !state.message.parts
      .slice(lastPartIndex + 1)
      .some((part) => part.type === "text" && part.text.trim().length > 0);
  });

  return (
    <ChainOfThought
      status={status}
      keepOpen={keepOpen}
      autoOpenKey={pendingApprovalKey}
    >
      {children}
    </ChainOfThought>
  );
};

function usePendingApprovalKey(indices: readonly number[]): string {
  return useAuiState((state) =>
    indices
      .flatMap((index) => {
        const part = state.message.parts[index];
        return part?.type === "tool-call" &&
          part.status.type === "requires-action"
          ? [part.toolCallId]
          : [];
      })
      .join("\u0000"),
  );
}

const ConversationActivityIndicator: FC = () => {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const messageIsLast = useAuiState((state) => state.message.isLast);
  const latestPartType = useAuiState(
    (state) => state.message.parts.at(-1)?.type,
  );
  const latestToolStatus = useAuiState((state) => {
    const latestPart = state.message.parts.at(-1);
    return latestPart?.type === "tool-call" ? latestPart.status.type : null;
  });

  if (!threadRunning || !messageIsLast) {
    return null;
  }

  const activity = getConversationActivity(
    latestPartType,
    latestToolStatus === "running",
  );

  return (
    <span
      data-slot="aui-assistant-message-indicator"
      className="inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
    >
      <DotMatrix
        state={activity.dotMatrixState}
        label={activity.label}
        className="size-3.5"
      />
      <span>{activity.label}</span>
    </span>
  );
};

function getConversationActivity(
  latestPartType: string | undefined,
  latestToolRunning: boolean,
): {
  label: string;
  dotMatrixState: "thinking" | "syncing" | "streaming";
} {
  if (latestPartType === "text") {
    return { label: "正在生成回答…", dotMatrixState: "streaming" };
  }

  if (latestPartType === "tool-call" && latestToolRunning) {
    return { label: "正在调用工具…", dotMatrixState: "syncing" };
  }

  if (latestPartType === "reasoning") {
    return { label: "正在分析…", dotMatrixState: "thinking" };
  }

  return { label: "正在思考…", dotMatrixState: "thinking" };
}

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="更多"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown
            asChild
            onExport={exportAssistantMessageMarkdown}
          >
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              导出 Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const { onUserMessageEditStart } = useContext(ThreadEditCallbacksContext);
  const messageId = useAuiState((state) => state.message.id);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex items-center gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton
          tooltip="复制"
          className="aui-user-action-copy"
        >
          <AuiIf condition={(state) => state.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(state) => !state.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton
          tooltip="编辑"
          className="aui-user-action-edit"
          onClick={() => onUserMessageEditStart?.(messageId)}
        >
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  const aui = useAui();
  const { onUserMessageEditCancel } = useContext(ThreadEditCallbacksContext);
  const removedMessageCount = useAuiState((state) => {
    const messageIndex = state.thread.messages.findIndex(
      (message) => message.id === state.message.id,
    );

    return messageIndex >= 0
      ? Math.max(0, state.thread.messages.length - messageIndex - 1)
      : 0;
  });
  const isSendDisabled = useAuiState(
    (state) =>
      !state.composer.canSend ||
      (state.thread.isRunning && !state.thread.capabilities.queue),
  );
  const sendEditedMessage = useCallback(() => {
    aui.composer().send({ startRun: true });
  }, [aui]);

  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-background border-border/60 dark:border-muted-foreground/15 dark:bg-muted/30 ms-auto flex w-full max-w-[85%] flex-col rounded-3xl border shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onUserMessageEditCancel?.();
            }
          }}
        />
        {removedMessageCount > 0 ? (
          <p className="text-muted-foreground px-4 pt-1 text-xs">
            重新发送后将移除其后的 {removedMessageCount} 条消息。
          </p>
        ) : null}
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
              onClick={onUserMessageEditCancel}
            >
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-full px-3.5"
            disabled={isSendDisabled}
            onClick={sendEditedMessage}
          >
            发送
          </Button>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};
