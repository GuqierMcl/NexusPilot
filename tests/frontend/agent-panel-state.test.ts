import { describe, expect, test } from "bun:test";

import {
    getAgentComposerSendBlocker,
    getAiRuntimeAvailabilityOverlay,
    getRuntimeMessageStatusView,
} from "../../src/features/workbench/agent/state";

describe("getAiRuntimeAvailabilityOverlay", () => {
    test("returns no overlay when Runtime is healthy", () => {
        expect(
            getAiRuntimeAvailabilityOverlay({
                endpointKnown: true,
                healthStatus: "healthy",
                isChecking: false,
                errorMessage: null,
            }),
        ).toBeNull();
    });

    test("uses short Runtime-level overlay messages", () => {
        expect(
            getAiRuntimeAvailabilityOverlay({
                endpointKnown: true,
                healthStatus: "unknown",
                isChecking: true,
                errorMessage: null,
            }),
        ).toEqual({
            kind: "checking",
            title: "正在连接 AI Runtime...",
            description: "请稍候，服务就绪后会自动恢复。",
        });

        expect(
            getAiRuntimeAvailabilityOverlay({
                endpointKnown: false,
                healthStatus: "unknown",
                isChecking: false,
                errorMessage: null,
            }),
        ).toEqual({
            kind: "starting",
            title: "AI Runtime 正在启动...",
            description: "请稍候，或检查本地 sidecar 状态。",
        });

        expect(
            getAiRuntimeAvailabilityOverlay({
                endpointKnown: true,
                healthStatus: "unhealthy",
                isChecking: false,
                errorMessage: "connection refused",
            }),
        ).toEqual({
            kind: "unavailable",
            title: "AI Runtime 暂不可用",
            description: "请稍候，或检查本地 sidecar 状态。",
        });
    });
});

describe("getAgentComposerSendBlocker", () => {
    test("prioritizes Runtime state over model state", () => {
        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: false,
                runtimeChecking: true,
                threadRunning: false,
                threadRecovering: false,
                modelPreferenceSelected: false,
                selectedModelAvailable: false,
                modelAvailabilityKnown: false,
                adapterErrorMessage: null,
            }),
        ).toEqual({
            code: "runtime_unavailable",
            message: "AI Runtime 暂不可用",
        });
    });

    test("uses the approved local Composer priority", () => {
        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: false,
                threadRunning: true,
                threadRecovering: true,
                modelPreferenceSelected: false,
                selectedModelAvailable: false,
                modelAvailabilityKnown: true,
                adapterErrorMessage: null,
            }),
        ).toEqual({ code: "running", message: "正在生成" });

        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: false,
                threadRunning: false,
                threadRecovering: true,
                modelPreferenceSelected: false,
                selectedModelAvailable: false,
                modelAvailabilityKnown: true,
                adapterErrorMessage: null,
            }),
        ).toEqual({ code: "recovering", message: "正在恢复对话" });

        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: false,
                threadRunning: false,
                threadRecovering: false,
                modelPreferenceSelected: false,
                selectedModelAvailable: false,
                modelAvailabilityKnown: true,
                adapterErrorMessage: null,
            }),
        ).toEqual({ code: "missing_model", message: "请选择模型" });

        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: false,
                threadRunning: false,
                threadRecovering: false,
                modelPreferenceSelected: true,
                selectedModelAvailable: false,
                modelAvailabilityKnown: true,
                adapterErrorMessage: null,
            }),
        ).toEqual({ code: "model_unavailable", message: "当前模型不可用" });
    });

    test("keeps sending available during a background Runtime health refresh", () => {
        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: true,
                threadRunning: false,
                threadRecovering: false,
                modelPreferenceSelected: true,
                selectedModelAvailable: true,
                modelAvailabilityKnown: true,
                adapterErrorMessage: null,
            }),
        ).toBeNull();
    });

    test("does not show an error for empty input", () => {
        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: false,
                threadRunning: false,
                threadRecovering: false,
                modelPreferenceSelected: true,
                selectedModelAvailable: true,
                modelAvailabilityKnown: true,
                adapterErrorMessage: null,
            }),
        ).toBeNull();
    });

    test("uses typed adapter errors as the final friendly blocker", () => {
        expect(
            getAgentComposerSendBlocker({
                runtimeAvailable: true,
                runtimeChecking: false,
                threadRunning: false,
                threadRecovering: false,
                modelPreferenceSelected: true,
                selectedModelAvailable: true,
                modelAvailabilityKnown: true,
                adapterErrorMessage: "当前版本暂不支持重新生成消息。",
            }),
        ).toEqual({
            code: "adapter_error",
            message: "当前版本暂不支持重新生成消息。",
        });
    });
});

describe("getRuntimeMessageStatusView", () => {
    test("returns lightweight interrupted status", () => {
        expect(
            getRuntimeMessageStatusView({
                nexus: {
                    status: { type: "incomplete", reason: "interrupted" },
                    interrupt: { reason: "user_stop" },
                },
            }),
        ).toEqual({
            kind: "interrupted",
            label: "执行已中断",
            description: "生成已中断",
        });
    });

    test("returns failed status from Runtime metadata", () => {
        expect(
            getRuntimeMessageStatusView({
                nexus: {
                    status: {
                        type: "error",
                        error: {
                            name: "APIError",
                            data: { message: "provider down" },
                        },
                    },
                },
            }),
        ).toEqual({
            kind: "failed",
            label: "执行失败",
            description: "provider down",
        });
    });

    test("preserves Runtime error whitespace and newlines exactly", () => {
        const message = "  maximum context length exceeded\nrequest id: abc  ";

        expect(
            getRuntimeMessageStatusView({
                custom: {
                    nexus: {
                        status: {
                            type: "error",
                            error: {
                                name: "APICallError",
                                data: { message },
                            },
                        },
                    },
                },
            }),
        ).toEqual({
            kind: "failed",
            label: "执行失败",
            description: message,
        });
    });

    test("reads Runtime status from assistant-ui preserved custom metadata", () => {
        expect(
            getRuntimeMessageStatusView({
                custom: {
                    nexus: {
                        status: { type: "incomplete", reason: "interrupted" },
                        interrupt: { reason: "user_stop" },
                    },
                },
            }),
        ).toEqual({
            kind: "interrupted",
            label: "执行已中断",
            description: "生成已中断",
        });
    });

    test("ignores complete messages", () => {
        expect(
            getRuntimeMessageStatusView({
                nexus: { status: { type: "complete" } },
            }),
        ).toBeNull();
    });
});
