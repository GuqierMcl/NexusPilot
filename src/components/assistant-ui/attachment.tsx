"use client";

import {
  type PropsWithChildren,
  type ReactElement,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type FC,
} from "react";
import { XIcon, PlusIcon, FileText, DownloadIcon } from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { saveRuntimeAttachment } from "@/components/assistant-ui/attachment-download";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { appendAiRuntimeAuthorization } from "@/lib/ai-runtime/endpoint";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import {
  getRuntimeAttachmentUploadUiState,
  subscribeRuntimeAttachmentUploadUiState,
} from "@/features/workbench/agent/runtime/runtime-attachment-adapter";
import { isSafeInlineImageType } from "@/features/workbench/agent/runtime/runtime-attachment-media";

const ATTACHMENT_SCHEME = "nexuspilot-attachment:";

const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return src;
};

const useRuntimeAttachmentSrc = (value: string | undefined, enabled: boolean) => {
  const endpoint = useAiRuntimeEndpointStore((state) => state.endpoint);
  const [src, setSrc] = useState<string | undefined>();
  const [error, setError] = useState(false);

  useEffect(() => {
    const attachmentId = value?.startsWith(ATTACHMENT_SCHEME)
      ? value.slice(ATTACHMENT_SCHEME.length)
      : null;
    if (!enabled || !attachmentId || !endpoint) {
      setSrc(undefined);
      setError(false);
      return;
    }
    setError(false);
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetch(
      `${endpoint.baseUrl.replace(/\/+$/, "")}/v1/attachments/${encodeURIComponent(attachmentId)}/content`,
      {
        headers: appendAiRuntimeAuthorization(undefined, endpoint.accessToken),
        signal: controller.signal,
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      objectUrl = URL.createObjectURL(await response.blob());
      setSrc(objectUrl);
      setError(false);
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      setSrc(undefined);
      setError(true);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, endpoint, value]);

  return { src, error };
};

const useAttachmentSrc = (enabled = true) => {
  const { file, src, isImage } = useAuiState(
    useShallow((s): { file?: File; src?: string; isImage: boolean } => {
      const filePart = s.attachment.content?.find((c) => c.type === "file");
      const isImage = isSafeInlineImageType(
        (filePart?.type === "file" ? filePart.mimeType : undefined) ?? s.attachment.contentType,
      );
      if (s.attachment.file) return { file: s.attachment.file, isImage };
      const image = s.attachment.content?.find((c) => c.type === "image");
      const src = image?.type === "image"
        ? image.image
        : filePart?.type === "file"
          ? filePart.data
          : undefined;
      if (!src) return { isImage };
      return { src, isImage };
    }),
  );

  const localSrc = useFileSrc(file);
  const runtime = useRuntimeAttachmentSrc(src, enabled && isImage);
  return {
    src: isImage
      ? localSrc ?? runtime.src ?? (src?.startsWith(ATTACHMENT_SCHEME) ? undefined : src)
      : undefined,
    error: runtime.error,
  };
};

const useViewportActivation = (enabled: boolean, identity: string | undefined) => {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [activation, setActivation] = useState({ identity, active: !enabled });
  const ref = useCallback((value: HTMLDivElement | null) => setNode(value), []);
  const active = activation.identity === identity ? activation.active : !enabled;

  useEffect(() => {
    if (!enabled) {
      setActivation({ identity, active: true });
      return;
    }
    setActivation({ identity, active: false });
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setActivation({ identity, active: true });
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setActivation({ identity, active: true });
        observer.disconnect();
      }
    }, { rootMargin: "128px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, identity, node]);

  return { active, ref };
};

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full object-contain",
        isLoaded
          ? "aui-attachment-preview-image-loaded"
          : "aui-attachment-preview-image-loading invisible",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren<{ src?: string }>> = ({ children, src }) => {
  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger hover:bg-accent/50 cursor-pointer transition-colors"
        render={children as ReactElement}
      />
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Image Attachment Preview
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC<{ src?: string; error: boolean }> = ({ src, error }) => {
  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={src}
        alt="Attachment preview"
        className="aui-attachment-tile-image object-cover"
      />
      <AvatarFallback>
        <span className="flex flex-col items-center gap-0.5" title={error ? "附件不可用" : undefined}>
          <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-8" />
          {error && <span className="text-destructive text-[9px]">附件不可用</span>}
        </span>
      </AvatarFallback>
    </Avatar>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";

  const { attachmentId, isImage, name, status, runtimeValue } = useAuiState(
    useShallow((s) => {
      const filePart = s.attachment.content?.find((part) => part.type === "file");
      return {
        attachmentId: s.attachment.id,
        isImage: isSafeInlineImageType(
          (filePart?.type === "file" ? filePart.mimeType : undefined) ?? s.attachment.contentType,
        ),
        name: s.attachment.name,
        status: s.attachment.status,
        runtimeValue: filePart?.type === "file" ? filePart.data : undefined,
      };
    }),
  );
  const uploadUiState = useSyncExternalStore(
    (listener) => subscribeRuntimeAttachmentUploadUiState(attachmentId, listener),
    () => getRuntimeAttachmentUploadUiState(attachmentId),
    () => undefined,
  );
  const viewport = useViewportActivation(isImage && !isComposer, runtimeValue);
  const attachmentSource = useAttachmentSrc(isComposer || !isImage || viewport.active);
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  const handleDownload = async () => {
    if (isImage || !runtimeValue?.startsWith(ATTACHMENT_SCHEME)) return;
    const endpoint = useAiRuntimeEndpointStore.getState().endpoint;
    if (!endpoint) {
      toast.error("附件保存失败，可重试");
      return;
    }
    const attachmentId = runtimeValue.slice(ATTACHMENT_SCHEME.length);
    try {
      const result = await saveRuntimeAttachment({
        attachmentId,
        baseUrl: endpoint.baseUrl,
        accessToken: endpoint.accessToken,
        name,
      });
      if (result === "saved") toast.success("附件已保存");
    } catch (error) {
      console.error("[assistant-ui] failed to save attachment", {
        attachmentId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      toast.error("附件保存失败，可重试");
    }
  };

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage &&
            !isComposer &&
            "aui-attachment-root-message only:*:first:size-24",
        )}
      >
        <AttachmentPreviewDialog src={attachmentSource.src}>
          <TooltipTrigger
            render={
              <div
              ref={viewport.ref}
              className="aui-attachment-tile bg-muted size-14 cursor-pointer overflow-hidden rounded-md border transition-opacity hover:opacity-75"
              role="button"
              tabIndex={0}
              aria-label={`${typeLabel} attachment`}
              onClick={() => void handleDownload()}
            >
              <AttachmentThumb src={attachmentSource.src} error={attachmentSource.error} />
              {status.type === "running" && (
                <span className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5 text-center text-[9px] text-white">
                  {Math.round(status.progress * 100)}%
                </span>
              )}
              {status.type === "incomplete" && uploadUiState?.phase !== "retrying" && (
                <span className="absolute inset-x-0 bottom-0 bg-destructive/90 px-1 py-0.5 text-center text-[9px] text-destructive-foreground">
                  上传失败
                </span>
              )}
              {uploadUiState?.phase === "retrying" && (
                <span className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5 text-center text-[9px] text-white">
                  重试 {Math.round(uploadUiState.progress * 100)}%
                </span>
              )}
              {!isImage && !isComposer && runtimeValue && (
                <DownloadIcon className="absolute bottom-1 right-1 size-3.5 rounded bg-background/80 p-0.5" />
              )}
            </div>
            }
          />
        </AttachmentPreviewDialog>
        {isComposer && <AttachmentRemove />}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
        {status.type === "incomplete" && (
          <span className="block text-xs">
            {uploadUiState?.message ?? status.message ?? "上传失败，发送时将自动重试。"}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="移除附件"
        className="aui-attachment-tile-remove text-muted-foreground hover:[&_svg]:text-destructive absolute end-1.5 top-1.5 size-3.5 rounded-full bg-white opacity-100 shadow-sm hover:bg-white! [&_svg]:text-black"
        side="top"
      >
        <XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="添加附件"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold"
        aria-label="添加附件"
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};
