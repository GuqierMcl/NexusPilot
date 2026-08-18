import { z } from "zod";

const customModelsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

export const providerConfigUpdateSchema = z.object({
  api_key: z.string().optional(),
  enabled: z.boolean().optional(),
  api_base: z.string().optional(),
});

export const modelConfigUpdateSchema = z.object({
  enabled: z.boolean(),
});

export const customProviderCreateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api_base: z.string().min(1),
  api_key: z.string().min(1),
  models: customModelsSchema.optional(),
});

export const customProviderModelDiscoverySchema = z.object({
  api_base: z.string().min(1),
  api_key: z.string().min(1),
});

export const customProviderToolCallingTestSchema = z.object({
  api_base: z.string().min(1),
  api_key: z.string().min(1),
  model_id: z.string().min(1),
});

export const customProviderUpdateSchema = z.object({
  name: z.string().min(1),
  api_base: z.string().min(1),
  api_key: z.string().optional(),
  models: customModelsSchema.optional(),
});

export function parseJsonBody<T>(schema: z.ZodType<T>, body: unknown): T | null {
  const result = schema.safeParse(body);
  return result.success ? result.data : null;
}

export async function parseRequestJsonBody<T>(
  schema: z.ZodType<T>,
  request: Request,
): Promise<T | null> {
  try {
    return parseJsonBody(schema, await request.json());
  } catch {
    return null;
  }
}
