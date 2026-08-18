export type RuntimeIdPrefix =
  | "conv"
  | "msg"
  | "part"
  | "run"
  | "tool"
  | "perm"
  | "evt"
  | "trace"
  | "diff";

export type RuntimeId<TPrefix extends RuntimeIdPrefix = RuntimeIdPrefix> =
  `${TPrefix}_${string}`;

export function createRuntimeId<TPrefix extends RuntimeIdPrefix>(
  prefix: TPrefix,
): RuntimeId<TPrefix> {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}` as RuntimeId<TPrefix>;
}

export function isRuntimeId<TPrefix extends RuntimeIdPrefix>(
  value: string,
  prefix: TPrefix,
): value is RuntimeId<TPrefix> {
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}
