import { z } from "zod";

/** Public identity only. Prompt text is resolved and snapshotted by the Runtime. */
export const commandBindingSchema = z
  .object({
    id: z.string().min(1).max(256),
    commandId: z.string().min(1).max(128),
    version: z.number().int().positive(),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export type CommandBinding = z.infer<typeof commandBindingSchema>;
export function validateCommandBinding(
  text: string,
  input: unknown,
): CommandBinding {
  const command = commandBindingSchema.parse(input);
  if (
    command.end <= command.start ||
    command.end > text.length ||
    text.slice(command.start, command.end) !== `/${command.name}`
  ) {
    throw new Error("命令范围与正文不一致");
  }
  return command;
}
export function commandBindingOpenApiSchema() {
  return z.toJSONSchema(commandBindingSchema, { target: "openapi-3.0" });
}
