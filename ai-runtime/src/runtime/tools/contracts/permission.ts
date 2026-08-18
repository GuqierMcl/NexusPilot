import type {
  Permission,
  PermissionPresentation,
  PermissionStatus,
} from "../../core/types";
import type { ResolvedToolRisk } from "./risk";
import type { ToolRiskResolutionContext } from "./context";

export type RuntimePolicyDecision = "allow" | "ask" | "deny";

export type ToolPermissionStatus = PermissionStatus;

export type ToolPermission = Permission;

export interface RuntimeToolPermissionDescription {
  inputSummary?: string;
  confirmationPrompt?: string;
  presentation?: PermissionPresentation;
}

export type RuntimeToolPermissionDescriber<TInput> = (
  input: TInput,
  risk: ResolvedToolRisk,
  context: ToolRiskResolutionContext,
) =>
  | RuntimeToolPermissionDescription
  | Promise<RuntimeToolPermissionDescription>;
