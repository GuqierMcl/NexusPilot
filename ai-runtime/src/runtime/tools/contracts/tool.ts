import type { z } from "zod";
import type { JsonObject } from "./json";
import type {
  DynamicToolRiskDefinition,
  ResolvedToolRisk,
  StaticToolRiskDefinition,
} from "./risk";
import type {
  BackendToolExecutionContext,
  ToolExecutionContext,
  ToolRiskResolutionContext,
} from "./context";
import type { ToolExecutionOutput } from "./result";
import type { RuntimeToolPermissionDescriber } from "./permission";
import type { BackendToolPrepareDefinition } from "./prepared";

export type ToolExecutionTarget = "runtime" | "backend";

export type DomainCapabilityId =
  | "schema_browser"
  | "data_table_browser"
  | "key_value_browser"
  | "sql_executor";

export interface ToolExecutionLimits {
  timeoutMs?: number;
  maxResultBytes?: number;
}

export type RuntimeToolSchema<TValue> = z.ZodType<TValue>;

interface RuntimeToolDefinitionBase<TInput, TOutput> {
  id: string;
  title: string;
  description: string;
  metadata?: JsonObject;
  inputSchema: RuntimeToolSchema<TInput>;
  outputSchema: RuntimeToolSchema<TOutput>;
  requiredCapabilities?: readonly DomainCapabilityId[];
  limits?: ToolExecutionLimits;
  describePermission?: RuntimeToolPermissionDescriber<TInput>;
}

interface RuntimeLocalToolExecution<TInput, TOutput> {
  executionTarget: "runtime";
  execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutput<TOutput>>;
}

interface BackendToolExecution<TInput, TOutput> {
  executionTarget: "backend";
  execute(
    input: TInput,
    context: BackendToolExecutionContext<TOutput>,
  ): Promise<ToolExecutionOutput<TOutput>>;
}

type ToolExecutionDefinition<TInput, TOutput> =
  | RuntimeLocalToolExecution<TInput, TOutput>
  | BackendToolExecution<TInput, TOutput>;

export type StaticRuntimeToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> = RuntimeToolDefinitionBase<TInput, TOutput> &
  ToolExecutionDefinition<TInput, TOutput> & {
    risk: StaticToolRiskDefinition;
    resolveRisk?: never;
    prepare?: never;
};

export type DynamicRuntimeToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> = RuntimeToolDefinitionBase<TInput, TOutput> &
  ToolExecutionDefinition<TInput, TOutput> & {
    risk: DynamicToolRiskDefinition;
  } & (
    | {
        resolveRisk(
          input: TInput,
          context: ToolRiskResolutionContext,
        ): Promise<ResolvedToolRisk>;
        prepare?: never;
      }
    | {
        executionTarget: "backend";
        prepare: BackendToolPrepareDefinition;
        resolveRisk?: never;
        describePermission?: never;
      }
  );

export type RuntimeToolDefinition<TInput = unknown, TOutput = unknown> =
  | StaticRuntimeToolDefinition<TInput, TOutput>
  | DynamicRuntimeToolDefinition<TInput, TOutput>;

export type BackendRuntimeToolDefinition<TInput = unknown, TOutput = unknown> =
  RuntimeToolDefinitionBase<TInput, TOutput> &
    BackendToolExecution<TInput, TOutput> &
    (
      | {
          risk: StaticToolRiskDefinition;
          resolveRisk?: never;
          prepare?: never;
        }
      | {
          risk: DynamicToolRiskDefinition;
        } & (
          | {
              resolveRisk(
                input: TInput,
                context: ToolRiskResolutionContext,
              ): Promise<ResolvedToolRisk>;
              prepare?: never;
            }
          | {
              prepare: BackendToolPrepareDefinition;
              resolveRisk?: never;
              describePermission?: never;
            }
        )
    );

export type AnyRuntimeToolDefinition =
  RuntimeToolDefinitionBase<any, any> & {
    executionTarget: ToolExecutionTarget;
    execute(
      input: any,
      context: any,
    ): Promise<ToolExecutionOutput<any>>;
  } & (
    | {
        risk: StaticToolRiskDefinition;
        resolveRisk?: never;
        prepare?: never;
      }
      | {
        risk: DynamicToolRiskDefinition;
      } & (
        | {
            resolveRisk(
              input: any,
              context: ToolRiskResolutionContext,
            ): Promise<ResolvedToolRisk>;
            prepare?: never;
          }
        | {
            prepare: BackendToolPrepareDefinition;
            resolveRisk?: never;
          }
      )
  );

type BackendToolAuthoringDefinition<TInput, TOutput> =
  BackendRuntimeToolDefinition<TInput, TOutput> extends infer TDefinition
    ? TDefinition extends BackendRuntimeToolDefinition<TInput, TOutput>
      ? Omit<TDefinition, "execute"> & {
          execute?: TDefinition["execute"];
        }
      : never
    : never;

export function defineBackendTool<TInput, TOutput>(
  definition: BackendToolAuthoringDefinition<TInput, TOutput>,
): BackendRuntimeToolDefinition<TInput, TOutput> {
  return {
    ...definition,
    execute:
      definition.execute ??
      (async (_input, context) => context.proceed()),
  } as BackendRuntimeToolDefinition<TInput, TOutput>;
}
