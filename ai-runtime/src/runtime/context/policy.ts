import type { ContextCompactionPolicy } from "./types";

export const CONTEXT_COMPACTION_POLICY_VERSION = "1";
export const CONTEXT_ESTIMATOR_VERSION = "utf8-bytes-v1";
export const CONTEXT_CHECKPOINT_FORMAT_VERSION = "1";
export const CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION = 1;

export const DEFAULT_CONTEXT_COMPACTION_POLICY: Readonly<ContextCompactionPolicy> =
  Object.freeze({
    version: CONTEXT_COMPACTION_POLICY_VERSION,
    softTriggerRatio: 0.8,
    targetRatio: 0.55,
    safetyMarginTokens: 4_096,
    minRawRuns: 2,
    summaryMaxOutputTokens: 2_048,
    summaryMaxChars: 16_000,
    estimatorVersion: CONTEXT_ESTIMATOR_VERSION,
    checkpointFormatVersion: CONTEXT_CHECKPOINT_FORMAT_VERSION,
    compatibilityVersion: CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION,
  });

export const CONTEXT_LINEAGE_HASH_VERSION = "1";
export const RUNTIME_SAFETY_STATE_VERSION = "1";
export const PROVIDER_NEUTRAL_CONTEXT_KIND = "provider-neutral-text";
