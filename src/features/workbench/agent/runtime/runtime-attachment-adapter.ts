import type {
    Attachment,
    AttachmentAdapter,
    CompleteAttachment,
    PendingAttachment,
} from "@assistant-ui/react";

import { appendAiRuntimeAuthorization } from "@/lib/ai-runtime/endpoint";
import { isSafeInlineImageType } from "./runtime-attachment-media";

const ATTACHMENT_SCHEME = "nexuspilot-attachment:";
const EXTERNAL_PROVIDER_NOTICE_KEY = "nexuspilot.agent.attachments.provider-notice.v1";

export interface RuntimeAttachmentSnapshot {
    id: string;
    filename: string;
    media_type: string;
    byte_length: number;
    state: "ready" | "corrupt" | "deleting";
}

interface UploadSessionSnapshot {
    upload_id: string;
    state: "pending" | "completed";
    expires_at?: number;
    attachment?: RuntimeAttachmentSnapshot;
}

interface UploadState {
    file: File;
    uploadId: string | null;
    attachment: RuntimeAttachmentSnapshot | null;
    task: Promise<RuntimeAttachmentSnapshot> | null;
    xhr: XMLHttpRequest | null;
    createController: AbortController | null;
    cancelled: boolean;
    failed: boolean;
}

export interface RuntimeAttachmentUploadUiState {
    phase: "uploading" | "failed" | "retrying" | "ready";
    progress: number;
    message?: string;
}

const uploadUiStates = new Map<string, RuntimeAttachmentUploadUiState>();
const uploadUiListeners = new Map<string, Set<() => void>>();

export function getRuntimeAttachmentUploadUiState(
    id: string,
): RuntimeAttachmentUploadUiState | undefined {
    return uploadUiStates.get(id);
}

export function subscribeRuntimeAttachmentUploadUiState(
    id: string,
    listener: () => void,
): () => void {
    const listeners = uploadUiListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    uploadUiListeners.set(id, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) uploadUiListeners.delete(id);
    };
}

function publishUploadUiState(id: string, state: RuntimeAttachmentUploadUiState): void {
    uploadUiStates.set(id, state);
    for (const listener of uploadUiListeners.get(id) ?? []) listener();
}

function removeUploadUiState(id: string): void {
    uploadUiStates.delete(id);
    for (const listener of uploadUiListeners.get(id) ?? []) listener();
}

export interface RuntimeAttachmentAdapterOptions {
    baseUrl: string;
    accessToken: string | null;
    onFirstAdd?: () => void;
}

export class RuntimeAttachmentAdapter implements AttachmentAdapter {
    readonly accept = "*";
    private readonly states = new Map<string, UploadState>();
    private readonly baseUrl: string;

    constructor(private readonly options: RuntimeAttachmentAdapterOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    }

    async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment, void> {
        this.notifyExternalProviderOnce();
        const id = `local_attachment_${crypto.randomUUID().replaceAll("-", "")}`;
        const state: UploadState = {
            file,
            uploadId: null,
            attachment: null,
            task: null,
            xhr: null,
            createController: null,
            cancelled: false,
            failed: false,
        };
        this.states.set(id, state);
        publishUploadUiState(id, { phase: "uploading", progress: 0 });
        const base = createPendingAttachment(id, file);
        yield { ...base, status: { type: "running", reason: "uploading", progress: 0 } };

        const progress = new ProgressChannel();
        state.task = this.upload(state, (value) => progress.push(value));
        void state.task.finally(() => progress.close()).catch(() => undefined);
        while (true) {
            const value = await progress.next();
            if (value === null) break;
            publishUploadUiState(id, { phase: "uploading", progress: value });
            yield {
                ...base,
                status: { type: "running", reason: "uploading", progress: value },
            };
        }

        try {
            await state.task;
            publishUploadUiState(id, { phase: "ready", progress: 1 });
            yield {
                ...base,
                status: { type: "requires-action", reason: "composer-send" },
            };
        } catch (error) {
            state.failed = true;
            publishUploadUiState(id, {
                phase: "failed",
                progress: 0,
                message: userFacingError(error),
            });
            yield {
                ...base,
                status: {
                    type: "incomplete",
                    reason: "error",
                    message: userFacingError(error),
                },
            };
        }
    }

    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
        const state = this.states.get(attachment.id);
        if (!state || state.cancelled) {
            throw new Error("附件上传状态已失效，请重新添加附件。");
        }
        if (!state.task || state.failed) {
            publishUploadUiState(attachment.id, { phase: "retrying", progress: 0 });
            state.task = this.upload(state, (progress) => {
                publishUploadUiState(attachment.id, { phase: "retrying", progress });
            });
        }
        let result: RuntimeAttachmentSnapshot;
        try {
            result = await state.task;
        } catch (error) {
            if (!state.cancelled) {
                state.failed = true;
                publishUploadUiState(attachment.id, {
                    phase: "failed",
                    progress: 0,
                    message: userFacingError(error),
                });
            }
            throw error;
        }
        publishUploadUiState(attachment.id, { phase: "ready", progress: 1 });
        return {
            ...attachment,
            name: result.filename,
            contentType: result.media_type,
            status: { type: "complete" },
            content: [{
                type: "file",
                filename: result.filename,
                mimeType: result.media_type,
                data: `${ATTACHMENT_SCHEME}${result.id}`,
            }],
        };
    }

    async remove(attachment: Attachment): Promise<void> {
        const state = this.states.get(attachment.id);
        if (!state) return;
        state.cancelled = true;
        state.createController?.abort();
        state.xhr?.abort();
        this.states.delete(attachment.id);
        removeUploadUiState(attachment.id);

        try {
            if (state.attachment) {
                await this.request(`/v1/attachments/${encodeURIComponent(state.attachment.id)}`, {
                    method: "DELETE",
                });
            } else if (state.uploadId) {
                await this.request(`/v1/attachment-uploads/${encodeURIComponent(state.uploadId)}`, {
                    method: "DELETE",
                });
            }
        } catch {
            // UI removal is immediate; Runtime TTL/GC safely converges failed cleanup.
        }
    }

    private async upload(
        state: UploadState,
        onProgress?: (progress: number) => void,
    ): Promise<RuntimeAttachmentSnapshot> {
        if (state.cancelled) throw new DOMException("Upload aborted", "AbortError");
        if (state.failed) {
            const failedUploadId = state.uploadId;
            state.uploadId = null;
            state.attachment = null;
            state.failed = false;
            if (failedUploadId) {
                await this.request(
                    `/v1/attachment-uploads/${encodeURIComponent(failedUploadId)}`,
                    { method: "DELETE" },
                ).catch(() => undefined);
            }
        }
        if (!state.uploadId) {
            const controller = new AbortController();
            state.createController = controller;
            let created: UploadSessionSnapshot;
            try {
                created = await this.request<UploadSessionSnapshot>(
                    "/v1/attachment-uploads",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            filename: state.file.name,
                            ...(state.file.type ? { media_type: state.file.type } : {}),
                            byte_length: state.file.size,
                        }),
                        signal: controller.signal,
                    },
                );
            } finally {
                if (state.createController === controller) state.createController = null;
            }
            state.uploadId = created.upload_id;
        }
        if (state.cancelled) {
            const cancelledUploadId = state.uploadId;
            state.uploadId = null;
            if (cancelledUploadId) {
                await this.request(
                    `/v1/attachment-uploads/${encodeURIComponent(cancelledUploadId)}`,
                    { method: "DELETE" },
                ).catch(() => undefined);
            }
            throw new DOMException("Upload aborted", "AbortError");
        }
        const completed = await this.putContent(state, onProgress);
        state.attachment = completed;
        state.failed = false;
        return completed;
    }

    private putContent(
        state: UploadState,
        onProgress?: (progress: number) => void,
    ): Promise<RuntimeAttachmentSnapshot> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            state.xhr = xhr;
            xhr.open(
                "PUT",
                `${this.baseUrl}/v1/attachment-uploads/${encodeURIComponent(state.uploadId!)}/content`,
            );
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            if (this.options.accessToken) {
                xhr.setRequestHeader("Authorization", `Bearer ${this.options.accessToken}`);
            }
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable && event.total > 0) {
                    onProgress?.(Math.min(1, event.loaded / event.total));
                }
            };
            xhr.onerror = () => reject(new Error("附件上传连接失败。"));
            xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
            xhr.onload = () => {
                state.xhr = null;
                const payload = parseJson(xhr.responseText);
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error(readApiMessage(payload) ?? `附件上传失败（HTTP ${xhr.status}）。`));
                    return;
                }
                const attachment = readAttachment(payload);
                if (!attachment) {
                    reject(new Error("AI Runtime 返回了无效的附件记录。"));
                    return;
                }
                onProgress?.(1);
                resolve(attachment);
            };
            xhr.send(state.file);
        });
    }

    private async request<T = void>(path: string, init: RequestInit): Promise<T> {
        const headers = appendAiRuntimeAuthorization(init.headers, this.options.accessToken);
        headers.set("Accept", "application/json");
        const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) {
            throw new Error(readApiMessage(payload) ?? `附件请求失败（HTTP ${response.status}）。`);
        }
        return payload as T;
    }

    private notifyExternalProviderOnce(): void {
        try {
            if (localStorage.getItem(EXTERNAL_PROVIDER_NOTICE_KEY) === "shown") return;
            localStorage.setItem(EXTERNAL_PROVIDER_NOTICE_KEY, "shown");
        } catch {
            // A restricted WebView may not expose persistent storage; showing again is safe.
        }
        this.options.onFirstAdd?.();
    }
}

function createPendingAttachment(id: string, file: File): Omit<PendingAttachment, "status"> {
    return {
        id,
        type: isSafeInlineImageType(file.type) ? "image" : "document",
        name: file.name || "attachment",
        contentType: file.type || "application/octet-stream",
        file,
    };
}

function parseJson(value: string): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function readApiMessage(value: unknown): string | null {
    return isRecord(value) && typeof value.message === "string" ? value.message : null;
}

function readAttachment(value: unknown): RuntimeAttachmentSnapshot | null {
    if (!isRecord(value) || !isRecord(value.attachment)) return null;
    const attachment = value.attachment;
    if (
        typeof attachment.id !== "string" ||
        !attachment.id.startsWith("att_") ||
        typeof attachment.filename !== "string" ||
        typeof attachment.media_type !== "string" ||
        typeof attachment.byte_length !== "number" ||
        attachment.state !== "ready"
    ) {
        return null;
    }
    return attachment as unknown as RuntimeAttachmentSnapshot;
}

function userFacingError(error: unknown): string {
    if (error instanceof DOMException && error.name === "AbortError") {
        return "附件上传已取消。";
    }
    return error instanceof Error ? error.message : "附件上传失败。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProgressChannel {
    private readonly values: number[] = [];
    private waiter: ((value: number | null) => void) | null = null;
    private closed = false;

    push(value: number): void {
        if (this.closed) return;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(value);
            return;
        }
        this.values.push(value);
    }

    close(): void {
        this.closed = true;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(null);
        }
    }

    async next(): Promise<number | null> {
        const value = this.values.shift();
        if (value !== undefined) return value;
        if (this.closed) return null;
        return await new Promise<number | null>((resolve) => {
            this.waiter = resolve;
        });
    }
}
