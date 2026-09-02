import type { DocumentDecoration } from "elysia";

type OpenApiRequestBody = NonNullable<DocumentDecoration["requestBody"]>;

export interface OpenApiSchema {
  type?: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  minimum?: number;
  minItems?: number;
  pattern?: string;
}

export function jsonRequestBody(
  schema: OpenApiSchema,
  description?: string,
): OpenApiRequestBody {
  return {
    ...(description ? { description } : {}),
    required: true,
    content: {
      "application/json": {
        schema,
      },
    },
  } as OpenApiRequestBody;
}

export const stringSchema: OpenApiSchema = {
  type: "string",
};

export const nullableStringSchema: OpenApiSchema = {
  type: "string",
  nullable: true,
};

export const booleanSchema: OpenApiSchema = {
  type: "boolean",
};

export const nullableBooleanSchema: OpenApiSchema = {
  type: "boolean",
  nullable: true,
};

export const unknownRecordSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: true,
};

export const customModelsSchema: OpenApiSchema = {
  type: "object",
  description: "OpenAI-compatible model 定义映射，key 为 runtime model id。",
  additionalProperties: {
    type: "object",
    additionalProperties: true,
  },
};
