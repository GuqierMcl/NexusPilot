import { ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { flushTapSync } from "@assistant-ui/tap";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FC,
} from "react";
import { cn } from "@/lib/utils";
import { readActiveTabPart, parseActiveTabContext, type ActiveTabContext } from "@contracts/active-tab-context";
import { readSqlEditorContentPart, type SqlEditorContentContext } from "@contracts/sql-editor-content-context";
import { useActiveTabDraft } from "./active-tab-context";
import { ActiveTabChip } from "./ActiveTabChip";
import {
  readComposerReferenceMetadata,
  validateTextReferences,
  validateReferenceMessage,
  type ReferencedText,
} from "@contracts/composer-references";
import {
  ComposerDraftHistory,
  detectComposerTrigger,
  editDraft,
  insertReference,
  reconcileDraft,
  removeReference,
  type ComposerDraft,
} from "./composer-draft";
import { useComposerRegistries } from "./composer-context";
import { useComposerOperations } from "./composer-operations";
import {
  searchSources,
  validateDraftTargets,
  type SourceSearchGroup,
} from "./composer-registry";
import { ComposerMenu, type ComposerMenuItem } from "./ComposerMenu";
import { ReferenceDetails, ReferenceText } from "./ReferenceText";
import { useComposerRecovery } from "./composer-recovery";
import { useAgentMessageEditController } from "../runtime/agent-message-edit-context";

export type AgentComposerInputProps = ComponentProps<
  typeof ComposerPrimitive.Input
> & { editing?: boolean };

export const AgentComposerInput: FC<AgentComposerInputProps> = (props) => {
  const threadId = useAuiState((state) => state.threadListItem.id);
  return props.editing ? (
    <EditInput key={`${threadId}:edit`} {...props} />
  ) : (
    <BoundInput key={threadId} {...props} />
  );
};
const EditInput: FC<AgentComposerInputProps> = (props) => {
  const id = useAuiState((state) => state.message.id);
  const metadata = useAuiState((state) => state.message.metadata);
  const content = useAuiState((state) => state.message.content);
  return (
    <BoundInput
      key={id}
      {...props}
      initial={readComposerReferenceMetadata(metadata) ?? undefined}
      initialActiveTab={readActiveTabPart(content)}
      initialActiveTabContent={readSqlEditorContentPart(content)}
    />
  );
};

const BoundInput: FC<
  AgentComposerInputProps & { initial?: ReferencedText; initialActiveTab?: ActiveTabContext; initialActiveTabContent?: SqlEditorContentContext }
> = ({ className, onKeyDown, editing: _editing, initial, initialActiveTab, initialActiveTabContent, ...props }) => {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threadListItem.id);
  const recovery = useComposerRecovery((state) => state.drafts[threadId]);
  const editController = useAgentMessageEditController();
  const attachmentCount = useAuiState(
    (state) => state.composer.attachments.length,
  );
  const { sources, commands } = useComposerRegistries();
  const operations = useComposerOperations();
  const text = useAuiState((state) => state.composer.text);
  const activeTab = useActiveTabDraft({ editing: _editing, initial: initialActiveTab, initialContent: initialActiveTabContent, text, attachmentCount });
  const [history] = useState(() => {
    const stored = _editing
      ? initial
      : readComposerReferenceMetadata({
          custom: aui.composer().getState().runConfig.custom,
        });
    return new ComposerDraftHistory({
      text,
      references: stored?.text === text ? stored.references : undefined,
      command: stored?.text === text ? stored.command : undefined,
      caret: text.length,
    });
  });
  const [draft, setDraft] = useState(history.current);
  const [caret, setCaret] = useState(text.length);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [groups, setGroups] = useState<SourceSearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const beforeEditRef = useRef<{
    start: number;
    end: number;
    text: string;
  } | null>(null);
  const composingRef = useRef(false);
  const pastedRef = useRef(false);
  const compositionBase = useRef<ComposerDraft | null>(null);
  const previousRuntimeText = useRef(text);
  const id = useId();
  const visible =
    text === draft.text ? draft : reconcileDraft(draft, text, caret);
  const trigger =
    !dismissed && !composing ? detectComposerTrigger(visible, caret) : null;

  const publish = useCallback(
    (next: ComposerDraft, focus = false): void => {
      setDraft(next);
      setCaret(next.caret);
      setError(null);
      const composer = aui.composer();
      flushTapSync(() => {
        composer.setRunConfig({
          ...composer.getState().runConfig,
          custom: {
            ...composer.getState().runConfig.custom,
            composerReferences: {
              text: next.text,
              references: next.references,
              command: next.command,
            },
            ...(!next.text && !composer.getState().attachments.length
              ? { recoveredEditMessageId: undefined }
              : {}),
          },
        });
        composer.setText(next.text);
      });
      if (focus)
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(next.caret, next.caret);
        });
    },
    [aui],
  );

  // Reset local binding history when the runtime clears a submitted draft.
  // Keep runConfig intact until the asynchronous attachment adapter captures it.
  useLayoutEffect(() => {
    if (previousRuntimeText.current === text) return;
    previousRuntimeText.current = text;
    if (text === "" && history.current.text !== "") {
      history.reset({ text: "", caret: 0 });
      setDraft(history.current);
      setCaret(0);
      setDismissed(true);
    } else if (text && history.current.text !== text) {
      const submitted = readComposerReferenceMetadata({
        custom: {
          composerReferences: aui.composer().getState().runConfig.custom
            ?.submittedComposerReferences,
        },
      });
      const next =
        history.current.text === "" && submitted?.text === text
          ? { ...submitted, caret: text.length }
          : reconcileDraft(history.current, text, text.length);
      publish(history.commit(next));
    }
  }, [text, history, aui, publish]);

  const recover = async (): Promise<void> => {
    if (!recovery?.failed || text || attachmentCount) return;
    try {
      const content = recovery.message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
      const annotated = readComposerReferenceMetadata(
        recovery.message.metadata,
      );
      const restoredActiveTab = readActiveTabPart(recovery.message.parts);
      const restoredActiveTabContent = readSqlEditorContentPart(recovery.message.parts);
      for (const part of recovery.message.parts) {
        if (part.type === "file")
          await aui.composer().addAttachment({
            name: part.filename ?? "附件",
            contentType: part.mediaType,
            content: [
              {
                type: "file",
                mimeType: part.mediaType,
                data: part.url,
              },
            ],
          });
      }
      publish(
        history.commit({
          text: content,
          command: annotated?.text === content ? annotated.command : undefined,
          references:
            annotated?.text === content ? annotated.references : undefined,
          caret: content.length,
        }),
        true,
      );
      const composer = aui.composer();
      flushTapSync(() =>
        composer.setRunConfig({
          ...composer.getState().runConfig,
          custom: {
            ...composer.getState().runConfig.custom,
            recoveredEditMessageId: recovery.replaceFromMessageId,
          },
        }),
      );
      useComposerRecovery.getState().clear(threadId);
      activeTab.restore({ metadata: restoredActiveTab, content: restoredActiveTabContent });
    } catch (cause) {
      console.error("[composer] recovery failed", cause);
      setError("恢复草稿失败，请重试");
    }
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const beforeInput = (event: InputEvent): void => {
      if (
        event.inputType === "historyUndo" ||
        event.inputType === "historyRedo"
      ) {
        event.preventDefault();
        publish(
          event.inputType === "historyUndo" ? history.undo() : history.redo(),
          true,
        );
        setDismissed(true);
        return;
      }
      // Native beforeinput includes deletion and paste, which React's
      // synthetic beforeInput does not consistently expose.
      beforeEditRef.current = {
        start: input.selectionStart,
        end: input.selectionEnd,
        text: input.value,
      };
    };
    input.addEventListener("beforeinput", beforeInput);
    return () => input.removeEventListener("beforeinput", beforeInput);
  }, [history, publish]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    const sync = (): void => {
      const style = getComputedStyle(input);
      for (const key of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "textIndent",
        "tabSize",
      ] as const)
        mirror.style[key] = style[key];
      mirror.style.width = `${input.clientWidth}px`;
      mirror.style.height = `${input.clientHeight}px`;
      mirror.scrollTop = input.scrollTop;
      mirror.scrollLeft = input.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    input.addEventListener("scroll", sync);
    return () => {
      observer.disconnect();
      input.removeEventListener("scroll", sync);
    };
  }, [text, className]);

  const searchKey = trigger?.kind === "reference" ? trigger.query : null;
  useEffect(() => {
    setSelected(0);
    setGroups([]);
    if (searchKey === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void searchSources(sources, searchKey, controller.signal).then(
      (results) => {
        if (!controller.signal.aborted) {
          setGroups(results);
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [searchKey, sources, searchRevision]);

  const refreshSources = (): void => {
    setError(null);
    setDismissed(false);
    void Promise.all(sources.list.map((source) => source.refresh?.()))
      .then(() => setSearchRevision((value) => value + 1))
      .catch((cause) => {
        console.error("[composer] refresh failed", cause);
        setError("来源刷新失败，请重试");
      });
  };

  useEffect(() => {
    const form = inputRef.current?.closest("form");
    if (!form) return;
    const prepare = (event: Event): void => {
      if (composingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      try {
        const current = reconcileDraft(
          history.current,
          aui.composer().getState().text,
          inputRef.current?.selectionStart ?? 0,
        );
        if (operations?.busy) throw new Error("请等待压缩结束，或取消压缩");
        const definition =
          current.command && commands.get(current.command.commandId);
        const action = definition?.action();
        if (action?.kind === "operation" && current.command) {
          event.preventDefault();
          event.stopPropagation();
          if (_editing) throw new Error("请在新消息输入框执行会话操作");
          if (!operations) throw new Error("当前环境不支持会话操作");
          if (!operations.availability.available)
            throw new Error(operations.availability.reason);
          const rest =
            current.text.slice(0, current.command.start) +
            current.text.slice(current.command.end);
          if (rest.trim() || aui.composer().getState().attachments.length)
            throw new Error("请单独发送此命令，不要混入正文、引用或附件");
          const submittedText = current.text;
          void operations
            .submit(action.operation)
            .then(() => {
              if (
                aui.composer().getState().text === submittedText &&
                history.current.command?.id === current.command?.id
              ) {
                history.reset({ text: "", caret: 0 });
                publish(history.current);
              }
            })
            .catch((cause) => {
              console.error("[composer] operation failed", cause);
              setError(
                cause instanceof Error ? cause.message : "会话操作失败，请重试",
              );
            });
          return;
        }
        validateReferenceMessage([current]);
        if (current.references)
          validateTextReferences(current.text, current.references);
        const errors = validateDraftTargets(
          sources,
          current.references?.targets ?? [],
        );
        if (errors.length) throw new Error(errors.join("\n"));
        const capturedActiveTab = activeTab.capture();
        const submittedActiveTabContext = capturedActiveTab.metadata ?? null;
        const submittedActiveTabContent = capturedActiveTab.content ?? null;
        const recoveredEditMessageId = aui.composer().getState().runConfig
          .custom?.recoveredEditMessageId;
        publish(current);
        const composer = aui.composer();
        flushTapSync(() =>
          composer.setRunConfig({
            ...composer.getState().runConfig,
            custom: {
              ...composer.getState().runConfig.custom,
              submittedComposerReferences: {
                text: current.text,
                references: current.references,
                command: current.command,
              },
              submittedActiveTabContext,
              submittedActiveTabContent,
              recoveredEditMessageId: undefined,
            },
          }),
        );
        if (typeof recoveredEditMessageId === "string")
          editController?.beginEdit(recoveredEditMessageId);
        setDismissed(true);
      } catch (cause) {
        console.error("[composer] send validation failed", cause);
        event.preventDefault();
        event.stopPropagation();
        setError(cause instanceof Error ? cause.message : "引用无法发送");
      }
    };
    form.addEventListener("submit", prepare, true);
    return () => form.removeEventListener("submit", prepare, true);
  }, [
    aui,
    history,
    publish,
    sources,
    commands,
    operations,
    _editing,
    editController,
    activeTab.capture,
  ]);

  const items: ComposerMenuItem[] =
    trigger?.kind === "reference"
      ? groups.flatMap((group) =>
          group.candidates.map((candidate) => ({
            key: `${group.sourceId}:${candidate.id}`,
            title: candidate.label,
            description: candidate.description,
            group: group.title,
            choose: () => {
              try {
                const source = sources.get(group.sourceId);
                if (!source) return;
                const target = source.capture(candidate);
                if (target.sourceId !== source.id)
                  throw new Error("引用来源与候选不一致");
                const next = insertReference(
                  visible,
                  trigger,
                  target,
                  crypto.randomUUID(),
                );
                validateTextReferences(next.text, next.references);
                publish(history.commit(next), true);
                setDismissed(true);
              } catch (cause) {
                console.error("[composer] reference capture failed", cause);
                setError(
                  cause instanceof Error ? cause.message : "无法添加引用",
                );
              }
            },
          })),
        )
      : trigger?.kind === "command"
        ? commands.search(trigger.query).map((command) => ({
            key: command.id,
            title: `/${command.name} · ${command.title}`,
            description:
              command.action().kind === "operation" &&
              (_editing || !operations?.availability.available)
                ? _editing
                  ? "历史编辑中不可执行会话操作"
                  : operations?.availability.available === false
                    ? operations.availability.reason
                    : "当前环境不支持会话操作"
                : command.description,
            choose: () => {
              try {
                const action = command.action();
                if (
                  action.kind === "operation" &&
                  (_editing || !operations?.availability.available)
                ) {
                  throw new Error(
                    _editing
                      ? "历史编辑中不可执行会话操作"
                      : operations?.availability.available === false
                        ? operations.availability.reason
                        : "当前环境不支持会话操作",
                  );
                }
                if (action.kind === "message" || action.kind === "operation") {
                  if (visible.command) throw new Error("请先移除已有命令");
                  const next = editDraft(
                    visible,
                    trigger.start,
                    trigger.end,
                    `/${command.name} `,
                  );
                  next.command = {
                    id: crypto.randomUUID(),
                    commandId: command.id,
                    version: action.version,
                    name: command.name,
                    start: trigger.start,
                    end: trigger.start + command.name.length + 1,
                  };
                  publish(history.commit(next), true);
                  setDismissed(true);
                  return;
                }
                publish(
                  history.commit(
                    editDraft(
                      visible,
                      trigger.start,
                      trigger.end,
                      action.kind === "template" ? action.text : "",
                    ),
                  ),
                  true,
                );
                if (action.kind === "help") setHelp(true);
                setDismissed(true);
              } catch (cause) {
                console.error("[composer] command failed", cause);
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "命令暂不可用，请重试",
                );
              }
            },
          }))
        : [];
  const chooseIndex = Math.min(selected, Math.max(0, items.length - 1));

  return (
    <div className="relative min-w-0" data-slot="agent-composer-input">
      {activeTab.snapshot && (
        <div className="px-2 pt-1" data-slot="composer-active-tab">
          <ActiveTabChip snapshot={activeTab.snapshot} onRemove={activeTab.remove} content={Boolean(activeTab.content)} contentWarning={Boolean(activeTab.contentWarning)} />
        </div>
      )}
      {activeTab.contentWarning && <div role="status" className="px-2 text-xs text-muted-foreground">{activeTab.contentWarning}</div>}
      {activeTab.error && <div role="alert" className="px-2 text-xs text-destructive">
        无法附加标签页信息
        <button type="button" className="ml-2 underline" onClick={activeTab.remove}>本条消息不附加</button>
      </div>}
      {!_editing &&
        operations &&
        (operations.busy ||
          operations.status === "not_needed" ||
          operations.status === "failed" ||
          operations.status === "interrupted") && (
          <div
            role="status"
            className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
          >
            {operations.busy
              ? "正在压缩上下文…"
              : operations.status === "not_needed"
                ? "当前没有需要压缩的上下文"
                : operations.status === "failed"
                  ? "上下文压缩失败"
                  : "上下文压缩已中止"}
            {operations.busy ? (
              <button
                type="button"
                className="underline"
                onClick={() => void operations.cancel()}
              >
                取消压缩
              </button>
            ) : operations.status === "failed" ||
              operations.status === "interrupted" ? (
              <button
                type="button"
                className="underline"
                onClick={() =>
                  void operations.retry().catch((cause) => {
                    console.error("[composer] retry failed", cause);
                    setError(
                      cause instanceof Error ? cause.message : "重试失败",
                    );
                  })
                }
              >
                重试
              </button>
            ) : null}
          </div>
        )}
      {!_editing && recovery?.failed && (
        <div role="alert" className="px-2 py-1 text-xs text-destructive">
          上次发送未完成，正文、附件和引用已保留。
          {text || attachmentCount ? "清空当前草稿后可恢复。" : ""}
          <button
            type="button"
            disabled={!!text || attachmentCount > 0}
            className="ml-2 underline disabled:opacity-50"
            onClick={() => void recover()}
          >
            恢复未发送草稿
          </button>
        </div>
      )}
      {trigger && (
        <ComposerMenu
          id={id}
          kind={trigger.kind}
          items={items}
          selected={chooseIndex}
          loading={loading && trigger.kind === "reference"}
          errors={
            trigger.kind === "reference"
              ? groups.flatMap((group) =>
                  group.error
                    ? [`${group.title}: ${group.error}`]
                    : group.candidates.length
                      ? []
                      : [
                          searchKey
                            ? `${group.title}: 无匹配项`
                            : `${group.title}: 暂无可引用对象`,
                        ],
                )
              : []
          }
          onSelect={setSelected}
          onRetry={refreshSources}
        />
      )}
      <ReferenceDetails
        references={visible.references}
        statusFor={sources.validate}
        onRemove={(key) =>
          publish(history.commit(removeReference(visible, key)))
        }
      />
      {help && (
        <div
          className="mx-2 rounded-md border bg-muted/30 p-2 text-xs"
          role="status"
        >
          <div className="flex justify-between">
            <strong>输入帮助</strong>
            <button
              type="button"
              aria-label="关闭帮助"
              onClick={() => setHelp(false)}
            >
              ×
            </button>
          </div>
          <p>
            @ 选择上下文；引用会随消息发送给当前模型，选择本身不读取数据库。
          </p>
          {commands.list
            .filter((command) => command.availability().available)
            .map((command) => (
              <p key={command.id}>
                /{command.name}：{command.description}
              </p>
            ))}
        </div>
      )}
      <div className="relative">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-foreground"
          style={{
            overflowWrap: "break-word",
            visibility: composing ? "hidden" : undefined,
          }}
        >
          <ReferenceText
            command={visible.command}
            text={text}
            references={visible.references}
          />
          {text.endsWith("\n") ? "\u200b" : ""}
        </div>
        <ComposerPrimitive.Input
          {...props}
          ref={inputRef}
          className={cn(
            className,
            "relative caret-foreground selection:bg-primary/25",
          )}
          cancelOnEscape={!trigger && !composing}
          style={{
            ...props.style,
            color: text && !composing ? "transparent" : undefined,
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!!trigger}
          aria-controls={trigger ? id : undefined}
          aria-activedescendant={
            trigger && items.length ? `${id}-${chooseIndex}` : undefined
          }
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
            history.current = {
              ...history.current,
              caret: event.currentTarget.selectionStart,
            };
          }}
          onBlur={() => setDismissed(true)}
          onFocus={() => setDismissed(false)}
          onChange={(event) => {
            const nextText = event.currentTarget.value;
            const position = event.currentTarget.selectionStart;
            let next = reconcileDraft(history.current, nextText, position);
            const before = beforeEditRef.current;
            if (
              before &&
              before.text === history.current.text &&
              before.end > before.start
            ) {
              const insertedLength =
                nextText.length -
                (before.text.length - (before.end - before.start));
              const replacement = nextText.slice(
                before.start,
                before.start + Math.max(0, insertedLength),
              );
              const exact = editDraft(
                history.current,
                before.start,
                before.end,
                replacement,
              );
              if (exact.text === nextText) next = { ...exact, caret: position };
            }
            beforeEditRef.current = null;
            if (composingRef.current) {
              history.current = next;
              publish(next);
            } else publish(history.commit(next));
            setDismissed(pastedRef.current);
            pastedRef.current = false;
            setSelected(0);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            compositionBase.current = history.current;
            setComposing(true);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            setComposing(false);
            const next = reconcileDraft(
              history.current,
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            );
            if (compositionBase.current)
              history.current = compositionBase.current;
            compositionBase.current = null;
            publish(history.commit(next));
            setDismissed(false);
          }}
          onPaste={() => {
            pastedRef.current = true;
            setDismissed(true);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              composingRef.current ||
              event.keyCode === 229
            ) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (
              (event.ctrlKey || event.metaKey) &&
              ["z", "y"].includes(event.key.toLowerCase())
            ) {
              event.preventDefault();
              publish(
                event.key.toLowerCase() === "y" || event.shiftKey
                  ? history.redo()
                  : history.undo(),
                true,
              );
              setDismissed(true);
              return;
            }
            if (trigger) {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissed(true);
                return;
              }
              if (event.key === "Tab") {
                setDismissed(true);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) =>
                  items.length
                    ? (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length
                    : 0,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                items[chooseIndex]?.choose();
                return;
              }
            }
            onKeyDown?.(event);
          }}
        />
      </div>
      {error && (
        <div
          role="alert"
          className="whitespace-pre-wrap px-2 py-1 text-xs text-destructive"
        >
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={refreshSources}
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
};

export const AgentComposerSend: FC = () => {
  const operations = useComposerOperations();
  const disabled = useAuiState(
    (state) =>
      !state.composer.canSend ||
      (state.thread.isRunning && !state.thread.capabilities.queue),
  );
  return (
    <button
      type="submit"
      disabled={disabled || operations?.busy}
      aria-label="发送"
      className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
    >
      ↑
    </button>
  );
};

export const AgentUserMessageContent: FC = () => {
  const content = useAuiState((state) => state.message.content);
  const metadata = useAuiState((state) => state.message.metadata);
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const annotated = readComposerReferenceMetadata(metadata);
  const hasSqlEditorContent = Boolean(readSqlEditorContentPart(content));
  const references =
    annotated?.text === text ? annotated.references : undefined;
  return (
    <div className="whitespace-pre-wrap break-words">
      <ReferenceText
        text={text}
        references={references}
        command={annotated?.text === text ? annotated.command : undefined}
      />
      <MessagePrimitive.Parts>
        {({ part }) => part.type === "data" && part.name === "active-tab-context"
          ? <span className="mt-1 block leading-none" data-slot="message-active-tab"><ActiveTabChip snapshot={parseActiveTabContext(part.data)} historical content={hasSqlEditorContent} /></span>
          : null}
      </MessagePrimitive.Parts>
    </div>
  );
};
