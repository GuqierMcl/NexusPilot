import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { createComposerMessage } from "../../src/features/workbench/agent/runtime/composer-message-adapter";
import { createAgentRuntimeTransportOptions } from "../../src/features/workbench/agent/runtime/create-agent-chat-transport";
import { buildRunCreateRequestFromAiSdkMessages } from "../../src/features/workbench/agent/runtime/run-request-adapter";
import { useComposerRecovery } from "../../src/features/workbench/agent/composer/composer-recovery";
import {
    combineReferencedTexts,
    referenceKey,
} from "@contracts/composer-references";

const target = {
    sourceId: "connections",
    type: "connection",
    version: 1,
    id: "p1",
    label: "开发",
    data: { driver: "sqlite" },
};
const annotated = {
    text: " @开发 ",
    references: {
        version: 1 as const,
        targets: [target],
        occurrences: [
            { id: "o1", start: 1, end: 4, targetKey: referenceKey(target) },
        ],
    },
};
const message: UIMessage = {
    id: "user",
    ...createComposerMessage({
        role: "user",
        parentId: null,
        sourceId: null,
        content: [{ type: "text", text: annotated.text }],
        runConfig: { custom: { composerReferences: annotated } },
        attachments: [
            {
                id: "a",
                name: "query.sql",
                type: "document",
                contentType: "text/plain",
                status: { type: "complete" },
                content: [
                    {
                        type: "file",
                        mimeType: "text/plain",
                        data: "nexuspilot-attachment:att_fixture",
                    },
                ],
            },
        ],
    }),
};

test("composer -> AI SDK optimistic message -> explicit HTTP text references, alongside attachments", () => {
    const request = buildRunCreateRequestFromAiSdkMessages({
        messages: [message],
        selectedModel: { providerId: "test", modelId: "test" },
    });
    expect(request.input.parts).toEqual([
        { type: "text", ...annotated },
        { type: "file", attachment_id: "att_fixture" },
    ]);
    expect(request.metadata).not.toHaveProperty("composerReferences");
});

test("submitted snapshot survives subsequent typing during asynchronous attachment completion", () => {
    const result = createComposerMessage({
        role: "user",
        parentId: null,
        sourceId: null,
        content: [{ type: "text", text: annotated.text }],
        runConfig: {
            custom: {
                composerReferences: { text: "next draft" },
                submittedComposerReferences: annotated,
            },
        },
    });
    expect(result.metadata).toMatchObject({
        custom: { composerReferences: annotated },
    });
});

test("multi-part history annotations split back into the correct text parts", () => {
    const combined = combineReferencedTexts([{ text: "前文" }, annotated]);
    const input: UIMessage = {
        id: "many",
        role: "user",
        parts: [
            { type: "text", text: "前文" },
            { type: "text", text: annotated.text },
        ],
        metadata: { custom: { composerReferences: combined } },
    };
    const result = buildRunCreateRequestFromAiSdkMessages({
        messages: [input],
        selectedModel: { providerId: "test", modelId: "test" },
    });
    expect(result.input.parts[0]).toEqual({ type: "text", text: "前文" });
    expect(result.input.parts[1]).toMatchObject({
        type: "text",
        text: annotated.text,
        references: { targets: [target], occurrences: [{ start: 1, end: 4 }] },
    });
});

test("adapter, HTTP and network rejection retain annotated draft, files and replacement per thread", async () => {
    for (const mode of ["adapter", "http", "network", "success"] as const) {
        const id = `recovery-${mode}`;
        const options = createAgentRuntimeTransportOptions({
            baseUrl: "http://localhost",
            getSelectedModel: () =>
                mode === "adapter"
                    ? null
                    : { providerId: "test", modelId: "test" },
            consumeReplacementMessageId: () => "msg_original",
            fetch: async () => {
                if (mode === "network") throw new Error("offline");
                return new Response("", {
                    status: mode === "http" ? 400 : 200,
                });
            },
        });
        const prepare = options.prepareSendMessagesRequest!;
        try {
            const request = await prepare({
                id,
                messages: [message],
                trigger: "submit-message",
            } as never);
            await options.fetch!("http://localhost", {
                body: JSON.stringify(request.body),
            });
        } catch {
            /* failure is asserted through the recovery snapshot below */
        }
        const recovery = useComposerRecovery.getState().drafts[id];
        if (mode === "success") expect(recovery).toBeUndefined();
        else {
            expect(recovery).toEqual({
                message,
                replaceFromMessageId: "msg_original",
                failed: true,
            });
            expect(recovery?.message.parts).toHaveLength(2);
        }
    }
    expect(
        useComposerRecovery.getState().drafts["another-thread"],
    ).toBeUndefined();
});
