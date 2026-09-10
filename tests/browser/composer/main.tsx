import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { Thread, VirtualizedThread } from "@/components/assistant-ui/thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerRegistryProvider } from "@/features/workbench/agent/composer/composer-context";
import { WorkbenchActiveTabProvider } from "@/features/workbench/agent/composer/active-tab-context";
import { useWorkbenchTabsStore } from "@/store/slices/workbench-tabs-slice";
import {
  ComposerOperationsProvider,
  type ComposerOperationState,
} from "@/features/workbench/agent/composer/composer-operations";
import {
  AgentComposerInput,
  AgentComposerSend,
  AgentUserMessageContent,
} from "@/features/workbench/agent/composer/AgentComposerInput";
import { createWorkbenchComposerRegistry } from "@/features/workbench/agent/composer/workbench-composer-registry";
import { createComposerMessage } from "@/features/workbench/agent/runtime/composer-message-adapter";
import { createAgentRuntimeTransportOptions } from "@/features/workbench/agent/runtime/create-agent-chat-transport";
import { AgentMessageEditProvider } from "@/features/workbench/agent/runtime/agent-message-edit-context";
import "@/index.css";

const state = window as any;
state.tabsStore = useWorkbenchTabsStore;
state.requests = [];
state.fail = false;
state.compactions = 0;
let replacement: string | null = null;
const editController = {
  beginEdit: (id: string) => {
    replacement = id;
  },
  cancelEdit: () => {
    replacement = null;
  },
};
function Observe() {
  const aui = useAui();
  state.aui = aui;
  state.messages = useAuiState((s) => s.thread.messages);
  state.threadId = useAuiState((s) => s.threadListItem.id);
  return null;
}
function App() {
  const [compactionStatus, setCompactionStatus] =
    useState<ComposerOperationState["status"]>();
  const operations: ComposerOperationState = {
    busy: compactionStatus === "preparing",
    status: compactionStatus,
    availability:
      compactionStatus === "preparing"
        ? { available: false, reason: "正在压缩上下文" }
        : { available: true },
    submit: async () => {
      state.compactions++;
      setCompactionStatus("preparing");
    },
    cancel: async () => {
      setCompactionStatus("interrupted");
    },
    retry: async () => {
      state.compactions++;
      setCompactionStatus("preparing");
    },
  };
  const [virtual, setVirtual] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const registry = useMemo(
    () =>
      createWorkbenchComposerRegistry(() => ({
        connections: deleted
          ? []
          : [
              { id: "profile-1", name: "开发库", driver: "postgresql" },
              { id: "profile-2", name: "开发库", driver: "mysql" },
              ...Array.from({ length: 23 }, (_, i) => ({
                id: `extra-${i}`,
                name: `连接 ${i}`,
                driver: "sqlite",
              })),
            ],
        isLoading: false,
        error: null,
      })),
    [deleted],
  );
  const transport = useMemo(
    () =>
      new AssistantChatTransport(
        createAgentRuntimeTransportOptions({
          baseUrl: "http://127.0.0.1:8787",
          getSelectedModel: () => ({ providerId: "test", modelId: "test" }),
          getConversationId: () => null,
          consumeReplacementMessageId: () => {
            const id = replacement;
            replacement = null;
            return id;
          },
          fetch: async (_url, init) => {
            const request = JSON.parse(init!.body as string);
            state.requests.push(request);
            if (state.fail)
              return new Response("Request rejected", { status: 400 });
            const id = `assistant-${state.requests.length}`;
            const events = [
              { type: "start", messageId: id },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "收到。" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: "stop" },
            ];
            return new Response(
              events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
                "data: [DONE]\n\n",
              {
                headers: {
                  "content-type": "text/event-stream",
                  "x-vercel-ai-ui-message-stream": "v1",
                },
              },
            );
          },
        }),
      ),
    [],
  );
  const runtime = useChatRuntime({
    transport,
    toCreateMessage: createComposerMessage,
    adapters: {
      attachments: {
        accept: "*",
        async add({ file }) {
          return {
            id: crypto.randomUUID(),
            type: "document",
            name: file.name,
            contentType: file.type || "text/plain",
            file,
            status: state.holdAttachments
              ? { type: "requires-action", reason: "composer-send" }
              : { type: "complete" },
            content: [
              {
                type: "file",
                mimeType: file.type || "text/plain",
                data: "nexuspilot-attachment:att_fixture",
              },
            ],
          };
        },
        async send(a) {
          if (state.holdAttachments)
            await new Promise((resolve) => (state.finishAttachment = resolve));
          return { ...a, status: { type: "complete" } };
        },
        async remove() {},
      },
    },
  });
  const View = virtual ? VirtualizedThread : Thread;
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <AgentMessageEditProvider controller={editController}>
          <ComposerOperationsProvider value={operations}>
            <ComposerRegistryProvider value={registry}>
              <WorkbenchActiveTabProvider>
              <Observe />
              <div className="flex h-screen flex-col bg-background text-foreground">
                <div className="flex gap-4 p-2">
                  <button onClick={() => setVirtual(!virtual)}>切换渲染</button>
                  <button
                    onClick={() =>
                      document.documentElement.classList.toggle("dark")
                    }
                  >
                    主题
                  </button>
                  <button onClick={() => setDeleted(!deleted)}>切换删除</button>
                </div>
                <div className="min-h-0 flex-1">
                  <View
                    variant="workbench"
                    onUserMessageEditStart={editController.beginEdit}
                    onUserMessageEditCancel={editController.cancelEdit}
                    components={{
                      ComposerInput: AgentComposerInput,
                      ComposerSendAction: AgentComposerSend,
                      UserMessageContent: AgentUserMessageContent,
                    }}
                  />
                </div>
              </div>
              </WorkbenchActiveTabProvider>
            </ComposerRegistryProvider>
          </ComposerOperationsProvider>
        </AgentMessageEditProvider>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
