import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import { useSelectedAiRuntimeModel } from "../model";
import { aiRuntimeRequest } from "@/lib/ai-runtime/request";
import type { SourceAvailability } from "./composer-registry";

export interface ComposerOperationState {
  busy: boolean;
  status?: "preparing" | "created" | "not_needed" | "failed" | "interrupted";
  availability: SourceAvailability;
  submit: (operation: "compact") => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
}
const Operations = createContext<ComposerOperationState | null>(null);
export const ComposerOperationsProvider = Operations.Provider;
export const useComposerOperations = (): ComposerOperationState | null =>
  useContext(Operations);
interface Operation {
  id: string;
  status: NonNullable<ComposerOperationState["status"]>;
}
export const WorkbenchComposerOperations: FC<PropsWithChildren> = ({
  children,
}) => {
  const conversationId = useAuiState((s) => s.threadListItem.remoteId);
  const threadId = useAuiState((s) => s.threadListItem.id);
  return (
    <ConversationOperations key={threadId} conversationId={conversationId}>
      {children}
    </ConversationOperations>
  );
};
const ConversationOperations: FC<
  PropsWithChildren<{ conversationId?: string }>
> = ({ conversationId, children }) => {
  const running = useAuiState((s) => s.thread.isRunning);
  const hasHistory = useAuiState((s) =>
    s.thread.messages.some((message) => message.role === "user"),
  );
  const { canRun, selectedModel } = useSelectedAiRuntimeModel();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(Boolean(conversationId));
  const [error, setError] = useState<string | null>(null);
  const key = useRef<{
    requestKey: string;
    providerId: string;
    modelId: string;
  } | null>(null);
  const submission = useRef(false);
  const revision = useRef(0);
  const path = `/v1/conversations/${encodeURIComponent(conversationId ?? "")}/compactions`;
  const busy = pending || operation?.status === "preparing";
  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    const load = async (): Promise<void> => {
      const captured = revision.current;
      try {
        const result = await aiRuntimeRequest<{ operation: Operation | null }>(
          path,
          { silent: true },
        );
        if (active && captured === revision.current) {
          setOperation(result.operation);
          setChecking(false);
          setError(null);
        }
      } catch (cause) {
        console.error("[composer] compaction status failed", cause);
        if (active && captured === revision.current) {
          setChecking(false);
          setError("暂时无法读取压缩状态");
        }
      }
    };
    void load();
    const timer = setInterval(
      () => void load(),
      operation?.status === "preparing" ? 1500 : 10000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [conversationId, path, operation?.status]);
  const availability: SourceAvailability =
    !conversationId || !hasHistory
      ? { available: false, reason: "空会话没有可压缩的上下文" }
      : checking
        ? { available: false, reason: "正在读取会话状态" }
        : error
          ? { available: false, reason: error }
          : running
            ? { available: false, reason: "请等待当前回复或审批结束" }
            : busy
              ? { available: false, reason: "正在压缩上下文" }
              : !canRun || !selectedModel
                ? { available: false, reason: "请选择可用模型" }
                : { available: true };
  const submit = async (): Promise<void> => {
    if (!availability.available) throw new Error(availability.reason);
    if (submission.current) throw new Error("正在提交压缩请求");
    submission.current = true;
    revision.current++;
    setPending(true);
    if (
      !key.current ||
      key.current.providerId !== selectedModel!.providerId ||
      key.current.modelId !== selectedModel!.modelId
    ) {
      key.current = {
        requestKey: crypto.randomUUID(),
        providerId: selectedModel!.providerId,
        modelId: selectedModel!.modelId,
      };
    }
    try {
      const result = await aiRuntimeRequest<{ operation: Operation }>(path, {
        method: "POST",
        silent: true,
        json: key.current,
      });
      setOperation(result.operation);
      key.current = null;
    } catch (cause) {
      console.error("[composer] compaction submit failed", cause);
      throw cause;
    } finally {
      revision.current++;
      submission.current = false;
      setPending(false);
    }
  };
  const cancel = async (): Promise<void> => {
    if (!operation) return;
    revision.current++;
    try {
      const result = await aiRuntimeRequest<{ operation: Operation }>(
        `${path}/${operation.id}/cancel`,
        { method: "POST" },
      );
      setOperation(result.operation);
    } catch (cause) {
      console.error("[composer] compaction cancellation failed", cause);
    }
  };
  return (
    <Operations.Provider
      value={{
        busy,
        status: operation?.status,
        availability,
        submit,
        cancel,
        retry: submit,
      }}
    >
      {children}
    </Operations.Provider>
  );
};
