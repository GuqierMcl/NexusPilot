"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useScrollLock,
  useToolCallElapsed,
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { ToolPermissionSnapshot } from "@/lib/ai-runtime/runs";
import { registerPermissionDecision } from "@/features/workbench/agent/runtime/permission-decision-registry";
import { useToolPermissionSnapshot } from "@/features/workbench/agent/runtime/tool-permission-context";
import { canApprovePermission } from "@/features/workbench/agent/runtime/permission-confirmation";

const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums",
        className,
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isInterrupted = isInterruptedToolStatus(status);

  const Icon = statusIconMap[statusType];
  const label = getToolStatusLabel(statusType, isInterrupted);

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit items-center gap-2 py-1 text-sm transition-colors",
        className,
      )}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isInterrupted && "text-muted-foreground",
          isRunning && "animate-spin",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper relative inline-block text-start leading-none",
          isInterrupted && "text-muted-foreground line-through",
        )}
      >
        <span>
          {label}: <b>{toolName}</b>
        </span>
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-fallback-trigger-shimmer"
            className="aui-tool-fallback-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}: <b>{toolName}</b>
          </span>
        )}
      </span>
      <ToolFallbackDuration />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function getToolStatusLabel(
  status: ToolStatus,
  isInterrupted: boolean,
): string {
  if (isInterrupted) return "调用已中断";

  switch (status) {
    case "running":
      return "正在调用";
    case "complete":
      return "已调用";
    case "incomplete":
      return "调用失败";
    case "requires-action":
      return "等待确认";
  }
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-2 ps-6 pt-1 pb-2">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-muted-foreground rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        Result:
      </p>
      <pre className="aui-tool-fallback-result-content bg-muted/50 text-muted-foreground mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isInterrupted = isInterruptedToolStatus(status);
  const headerText = isInterrupted ? "Interrupted reason:" : "Error:";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">
        {errorText}
      </p>
    </div>
  );
}

const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  "allow-once": "Allow",
  "allow-always": "Always allow",
  "reject-once": "Deny",
  "reject-always": "Always deny",
};

const isAllowKind = (kind: string) =>
  kind === "allow-once" || kind === "allow-always";

const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ??
  (Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, option.kind)
    ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind]
    : undefined) ??
  option.id;

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  permission,
  permissionLoading,
  respondToApproval,
  onApproved,
  ...props
}: React.ComponentProps<"div"> &
  Partial<
    Pick<ToolCallMessagePartProps, "addResult" | "resume" | "respondToApproval">
  > & {
    interrupt?: ToolCallMessagePart["interrupt"];
    approval?: ToolCallMessagePart["approval"];
    permission?: ToolPermissionSnapshot | null;
    permissionLoading?: boolean;
    onApproved?: () => void;
  }) {
  const [submitted, setSubmitted] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmationText, setConfirmationText] = useState("");

  if (
    approval != null &&
    (approval.approved !== undefined || approval.resolution !== undefined)
  )
    return null;

  // Custom (`_`-prefixed) kinds cannot be resolved to a boolean by the kit;
  // hosts using custom kinds render their own bar. A declared option list is
  // a host constraint: the kit never adds an approval path beyond it, but
  // always preserves a refusal path.
  const declaredOptions = respondToApproval ? approval?.options : undefined;
  const options = declaredOptions?.filter((o) =>
    Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, o.kind),
  );

  const respond = (approved: boolean) => {
    if (submitted) return;
    if (
      approved &&
      approval != null &&
      !canApprovePermission(permission ?? null, confirmationText)
    ) {
      return;
    }
    if (approval != null && !permission) {
      return;
    }
    if (
      approval != null &&
      approval.approved === undefined &&
      respondToApproval
    ) {
      registerPermissionDecision(approval.id, {
        permissionId: permission!.id,
        ...(approved && permission?.confirmation.level === "strong"
          ? { confirmationText }
          : {}),
      });
      respondToApproval({ approved });
    } else if (interrupt) {
      resume?.({ approved });
    } else {
      addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    }
    if (approved) {
      onApproved?.();
    }
    setSubmitted(true);
  };

  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    respondToApproval?.({ optionId: option.id });
    if (isAllowKind(option.kind)) {
      onApproved?.();
    }
    setSubmitted(true);
    setConfirmingId(null);
  };

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) {
      setConfirmingId(option.id);
    } else {
      respondWithOption(option);
    }
  };

  const confirming =
    confirmingId != null
      ? options?.find((o) => o.id === confirmingId)
      : undefined;

  if (confirming) {
    const confirmMeta =
      typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription =
      confirmMeta?.description ?? confirming.description;
    return (
      <div
        data-slot="tool-fallback-approval-confirm"
        className={cn(
          "aui-tool-fallback-approval-confirm flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        <p className="aui-tool-fallback-approval-confirm-title font-semibold">
          {confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}
        </p>
        {confirmDescription && (
          <p className="aui-tool-fallback-approval-confirm-description text-muted-foreground">
            {confirmDescription}
          </p>
        )}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul className="aui-tool-fallback-approval-confirm-grants flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="aui-tool-fallback-approval-confirm-grant bg-muted rounded px-1.5 py-0.5 text-xs">
                  {grant}
                </code>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => respondWithOption(confirming)}
            disabled={submitted}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmingId(null)}
            disabled={submitted}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = options?.filter((o) => isAllowKind(o.kind)) ?? [];
    const rejectOptions = options?.filter((o) => !isAllowKind(o.kind)) ?? [];
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-wrap items-center gap-2 pt-1",
          className,
        )}
        {...props}
      >
        {[...allowOptions, ...rejectOptions].map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option === allowOptions[0] ? "default" : "outline"}
            onClick={() => handleOption(option)}
            disabled={submitted}
          >
            {approvalOptionLabel(option)}
          </Button>
        ))}
        {rejectOptions.length === 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => respond(false)}
            disabled={submitted}
          >
            Deny
          </Button>
        )}
      </div>
    );
  }

  const requiresStrongConfirmation =
    permission?.confirmation.level === "strong";
  const approvalDisabled =
    submitted ||
    permissionLoading ||
    (approval != null &&
      !canApprovePermission(permission ?? null, confirmationText));

  return (
    <div
      data-slot="tool-fallback-approval"
      className={cn(
        "aui-tool-fallback-approval flex items-center gap-2 pt-1",
        className,
      )}
      {...props}
    >
      {requiresStrongConfirmation && (
        <label className="flex w-full flex-col gap-1.5">
          <span className="text-xs font-medium">输入以下确认文本以继续</span>
          <code className="bg-muted rounded px-2 py-1.5 text-xs select-all">
            {permission.confirmation.prompt}
          </code>
          <input
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
            className="border-input bg-background h-8 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoComplete="off"
            spellCheck={false}
            aria-label="强确认文本"
          />
        </label>
      )}
      <Button
        size="sm"
        onClick={() => respond(true)}
        disabled={approvalDisabled}
      >
        批准本次执行
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => respond(false)}
        disabled={submitted || permissionLoading || (approval != null && !permission)}
      >
        拒绝
      </Button>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isInterrupted = isInterruptedToolStatus(status);
  const isRequiresAction = status?.type === "requires-action";
  const permissionState = useToolPermissionSnapshot(
    isRequiresAction ? approval?.id : undefined,
  );

  const [open, setOpen] = useState(isRequiresAction);
  const pendingApprovalKey = isRequiresAction ? approval?.id : undefined;
  const approvedApprovalKey =
    approval?.approved === true ? approval.id : undefined;
  useEffect(() => {
    if (pendingApprovalKey) {
      setOpen(true);
    }
  }, [pendingApprovalKey]);
  useEffect(() => {
    if (approvedApprovalKey) {
      setOpen(false);
    }
  }, [approvedApprovalKey]);

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs
          argsText={argsText}
          className={cn(isInterrupted && "opacity-60")}
        />
        {isRequiresAction && (
          <ToolPermissionDetails
            permission={permissionState.permission}
            loading={permissionState.loading}
            error={permissionState.error}
          />
        )}
        {isRequiresAction && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            permission={permissionState.permission}
            permissionLoading={permissionState.loading}
            respondToApproval={respondToApproval}
            onApproved={() => setOpen(false)}
          />
        )}
        {!isInterrupted && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

function ToolPermissionDetails({
  permission,
  loading,
  error,
}: {
  permission: ToolPermissionSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <p className="text-muted-foreground text-xs">正在加载审批快照…</p>;
  }
  if (error || !permission) {
    return (
      <p className="text-destructive text-xs">
        无法加载审批快照，执行保持锁定。{error ? ` ${error}` : ""}
      </p>
    );
  }

  const target = permission.presentation?.target;
  const sql = permission.presentation?.sql;
  const keyValue = permission.presentation?.key_value;
  return (
    <div className="border-border bg-muted/20 flex flex-col gap-3 rounded-md border p-3">
      <div className="grid gap-1 text-xs sm:grid-cols-2">
        <PermissionField label="工具" value={`${permission.title} · ${permission.tool_id}`} />
        <PermissionField label="风险" value={`${permission.risk.level} · ${permission.risk.reversible ? "可逆" : "不可逆"}`} />
        <PermissionField label="连接" value={target?.connection_name} />
        <PermissionField label="驱动 / 环境" value={[target?.driver, target?.environment].filter(Boolean).join(" / ")} />
        <PermissionField label="数据库 / Schema" value={[target?.database, target?.schema].filter(Boolean).join(" / ")} />
        <PermissionField label="Redis DB" value={target?.redis_db_index?.toString()} />
        <PermissionField label="SQL 分析" value={sql?.analysis_status} />
        <PermissionField label="语句类别" value={sql?.statement_class} />
        <PermissionField label="识别目标" value={sql?.identified_targets?.join(", ")} />
        <PermissionField label="Key/Value 操作" value={keyValue?.operation} />
        <PermissionField label="完整 Key" value={keyValue?.key} />
        <PermissionField label="新 Key" value={keyValue?.new_key} />
        <PermissionField label="值类型" value={keyValue?.value_type} />
        <PermissionField
          label="TTL"
          value={
            keyValue?.ttl_mode
              ? `${keyValue.ttl_mode}${keyValue.ttl_seconds !== undefined ? ` · ${keyValue.ttl_seconds} 秒` : ""}`
              : undefined
          }
        />
        <PermissionField label="超时" value={permission.presentation?.timeout_ms !== undefined ? `${permission.presentation.timeout_ms} ms` : undefined} />
        <PermissionField label="结果上限" value={permission.presentation?.max_result_bytes !== undefined ? `${permission.presentation.max_result_bytes} bytes` : undefined} />
      </div>
      {permission.presentation?.risk_reasons?.length ? (
        <PermissionList title="风险原因" items={permission.presentation.risk_reasons} />
      ) : null}
      {permission.presentation?.outcome_warnings?.length ? (
        <PermissionList title="结果与影响提示" items={permission.presentation.outcome_warnings} />
      ) : null}
      {sql && (
        <div>
          <p className="mb-1 text-xs font-medium">完整 SQL（只读）</p>
          <pre className="bg-background max-h-72 overflow-auto rounded border p-2 text-xs whitespace-pre-wrap">
            {sql.text}
          </pre>
        </div>
      )}
    </div>
  );
}

function PermissionField({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  if (!value) return null;
  return (
    <div>
      <span className="text-muted-foreground">{label}：</span>
      <span>{value}</span>
    </div>
  );
}

function PermissionList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="text-xs">
      <p className="font-medium">{title}</p>
      <ul className="text-muted-foreground list-disc ps-4">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function isInterruptedToolStatus(status: ToolCallMessagePartStatus | undefined): boolean {
  const reason = status?.type === "incomplete" ? String(status.reason) : null;
  return (
    status?.type === "incomplete" &&
    (reason === "interrupted" || reason === "cancelled")
  );
}

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
