export type ProviderProtocol = "openai" | "anthropic" | "openai_compatible";
export type ProviderSource = "preset" | "custom";
export type ModelModality = "text" | "image" | "audio" | "video" | "pdf";

export interface ModelCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsAttachments: boolean;
  supportsInterleavedReasoning: boolean;
  supportsStructuredOutput: boolean;
  temperature: boolean;
  inputModalities: ModelModality[];
  outputModalities: ModelModality[];
}

export interface ModelCost {
  input: number;
  output: number;
}

export interface ProviderModel {
  id: string;
  providerId: string;
  upstreamId: string;
  name: string;
  contextLength: number;
  outputLength: number;
  capabilities: ModelCapabilities;
  cost: ModelCost;
  source: ProviderSource;
  enabled: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string | null;
  enabled: boolean;
  source: ProviderSource;
  apiProtocol: ProviderProtocol;
  models: Record<string, ProviderModel>;
}
