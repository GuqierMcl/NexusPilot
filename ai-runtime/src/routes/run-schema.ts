import { z } from "zod";
import type {
  AttachmentId,
  RuntimePermissionResponseInput,
  RunRequest,
} from "../runtime";
import { isRuntimeId } from "../runtime";

const runResponseModeSchema = z.enum(["stream"]);

export type RunResponseMode = z.infer<typeof runResponseModeSchema>;

export interface ParsedRunCreateRequest {
  responseMode: RunResponseMode;
  runRequest: RunRequest;
}

export interface ParsedRunContinueRequest {
  permissionResponses: RuntimePermissionResponseInput[];
}

const textInputPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().trim().min(1),
  })
  .strict();

const fileInputPartSchema = z
  .object({
    type: z.literal("file"),
    attachment_id: z.string().refine((value) => isRuntimeId(value, "att")),
  })
  .strict();

const runInputPartSchema = z.discriminatedUnion("type", [
  textInputPartSchema,
  fileInputPartSchema,
]);

export type RunInputPart = z.infer<typeof runInputPartSchema>;

const runCreateRequestSchema = z
  .object({
    response_mode: runResponseModeSchema,
    conversation_id: z.string().optional(),
    replace_from_message_id: z.string().optional(),
    model: z
      .object({
        provider_id: z.string().trim().min(1),
        model_id: z.string().trim().min(1),
      })
      .strict(),
    agent_mode: z.enum(["ask", "query", "agent"]).optional(),
    input: z
      .object({
        parts: z.array(runInputPartSchema).min(1),
      })
      .strict(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const runContinueRequestSchema = z
  .object({
    permission_responses: z
      .array(
        z
          .object({
            permission_id: z.string(),
            approved: z.boolean(),
            confirmation_text: z.string().optional(),
            reason: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function parseRunCreateRequestBody(body: unknown): ParsedRunCreateRequest | null {
  const result = runCreateRequestSchema.safeParse(body);
  if (!result.success) {
    return null;
  }

  const conversationId = result.data.conversation_id;
  if (conversationId !== undefined && !isRuntimeId(conversationId, "conv")) {
    return null;
  }
  const replaceFromMessageId = result.data.replace_from_message_id;
  if (
    replaceFromMessageId !== undefined &&
    (!conversationId || !isRuntimeId(replaceFromMessageId, "msg"))
  ) {
    return null;
  }

  const parts = result.data.input.parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "file" as const,
          attachmentId: part.attachment_id as AttachmentId,
        },
  );
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");

  return {
    responseMode: result.data.response_mode,
    runRequest: {
      ...(conversationId ? { conversationId } : {}),
      ...(replaceFromMessageId ? { replaceFromMessageId } : {}),
      providerId: result.data.model.provider_id,
      modelId: result.data.model.model_id,
      text,
      parts,
      agentMode: result.data.agent_mode,
      metadata: result.data.metadata,
    },
  };
}

export function parseRunContinueRequestBody(
  body: unknown,
): ParsedRunContinueRequest | null {
  const result = runContinueRequestSchema.safeParse(body);
  if (
    !result.success ||
    result.data.permission_responses.some(
      (response) => !isRuntimeId(response.permission_id, "perm"),
    )
  ) {
    return null;
  }
  return {
    permissionResponses: result.data.permission_responses.map((response) => ({
      permissionId:
        response.permission_id as RuntimePermissionResponseInput["permissionId"],
      approved: response.approved,
      ...(response.confirmation_text !== undefined
        ? { confirmationText: response.confirmation_text }
        : {}),
      ...(response.reason ? { reason: response.reason } : {}),
    })),
  };
}
