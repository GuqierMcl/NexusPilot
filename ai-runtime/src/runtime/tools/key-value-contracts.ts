import { z } from "zod";

const profileIdSchema = z.string().min(1);
const dbIndexSchema = z.number().int().min(0).max(255);
const keySchema = z.string().min(1).max(4096);
const valueTextSchema = z.string().max(256 * 1024);
const collectionTextSchema = z.string().max(4096);
const collectionFieldSchema = z.string().min(1).max(4096);
const ttlSecondsSchema = z.number().int().min(1).max(31_536_000);

const redisHashEntrySchema = z.object({
  field: collectionFieldSchema,
  value: collectionTextSchema,
}).strict();

const redisEditableValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("string"),
    value: valueTextSchema,
  }).strict(),
  z.object({
    kind: z.literal("json"),
    value: valueTextSchema,
  }).strict(),
  z.object({
    kind: z.literal("hash"),
    value: z.array(redisHashEntrySchema).min(1).max(1000),
  }).strict(),
  z.object({
    kind: z.literal("list"),
    value: z.array(collectionTextSchema).min(1).max(1000),
  }).strict(),
  z.object({
    kind: z.literal("set"),
    value: z.array(collectionTextSchema).min(1).max(1000),
  }).strict(),
  z.object({
    kind: z.literal("sorted_set"),
    value: z.array(z.object({
      member: collectionTextSchema,
      score: z.number().finite(),
    }).strict()).min(1).max(1000),
  }).strict(),
  z.object({
    kind: z.literal("stream"),
    value: z.array(z.object({
      id: z.string().min(1).max(128),
      fields: z.array(redisHashEntrySchema).min(1).max(100),
    }).strict()).min(1).max(1000),
  }).strict(),
]);

const baseTargetSchema = {
  profileId: profileIdSchema.describe(
    "connection.list 返回的精确 Redis profileId；连接必须已经打开。",
  ),
  dbIndex: dbIndexSchema,
};

const ttlPolicyFields = {
  ttlPolicy: z.enum(["keep", "persist", "expire"]).default("keep"),
  ttlSeconds: ttlSecondsSchema.optional(),
};

export const keyValueCreateRequestSchema = z.object({
  ...baseTargetSchema,
  key: keySchema,
  value: redisEditableValueSchema,
  ttlSeconds: ttlSecondsSchema.optional().describe(
    "省略表示持久 Key；提供时为新 Key 设置过期秒数。",
  ),
}).strict();

export const keyValueSetRequestSchema = z.object({
  ...baseTargetSchema,
  key: keySchema,
  value: redisEditableValueSchema,
  ...ttlPolicyFields,
}).strict().superRefine((value, context) => {
  if (value.ttlPolicy === "expire" && value.ttlSeconds === undefined) {
    context.addIssue({
      code: "custom",
      path: ["ttlSeconds"],
      message: "ttlPolicy=expire requires ttlSeconds",
    });
  }
  if (value.ttlPolicy !== "expire" && value.ttlSeconds !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["ttlSeconds"],
      message: "ttlSeconds is only valid when ttlPolicy=expire",
    });
  }
});

export const keyValueRenameRequestSchema = z.object({
  ...baseTargetSchema,
  key: keySchema,
  newKey: keySchema,
}).strict().refine((value) => value.key !== value.newKey, {
  path: ["newKey"],
  message: "newKey must differ from key",
});

export const keyValueSetTtlRequestSchema = z.object({
  ...baseTargetSchema,
  key: keySchema,
  mode: z.enum(["expire", "persist"]).describe(
    "expire 设置过期时间且必须提供 ttlSeconds；persist 移除 TTL 且不得提供 ttlSeconds。",
  ),
  ttlSeconds: ttlSecondsSchema.optional().describe(
    "仅 mode=expire 时提供，表示 Key 的过期秒数。",
  ),
}).strict().superRefine((value, context) => {
  if (value.mode === "expire" && value.ttlSeconds === undefined) {
    context.addIssue({
      code: "custom",
      path: ["ttlSeconds"],
      message: "mode=expire requires ttlSeconds",
    });
  }
  if (value.mode === "persist" && value.ttlSeconds !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["ttlSeconds"],
      message: "ttlSeconds is only valid when mode=expire",
    });
  }
});

export const keyValueDeleteRequestSchema = z.object({
  ...baseTargetSchema,
  key: keySchema,
}).strict();

const jsonSafeUnsignedIntegerSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const keyValueMutationResponseSchema = z.object({
  dbIndex: dbIndexSchema,
  key: z.string(),
  valueType: z.string(),
  ttl: z.number().int(),
  size: jsonSafeUnsignedIntegerSchema.nullable(),
  mutationState: z.literal("completed"),
}).strict();

export const keyValueDeleteResponseSchema = z.object({
  dbIndex: dbIndexSchema,
  key: z.string(),
  deletedCount: z.literal(1),
  mutationState: z.literal("completed"),
}).strict();

export type KeyValueCreateRequest = z.infer<typeof keyValueCreateRequestSchema>;
export type KeyValueSetRequest = z.infer<typeof keyValueSetRequestSchema>;
export type KeyValueRenameRequest = z.infer<typeof keyValueRenameRequestSchema>;
export type KeyValueSetTtlRequest = z.infer<typeof keyValueSetTtlRequestSchema>;
export type KeyValueDeleteRequest = z.infer<typeof keyValueDeleteRequestSchema>;
export type KeyValueMutationResponse = z.infer<
  typeof keyValueMutationResponseSchema
>;
export type KeyValueDeleteResponse = z.infer<
  typeof keyValueDeleteResponseSchema
>;
