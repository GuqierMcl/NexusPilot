const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface DiscoveredOpenAICompatibleModel {
  id: string;
  name: string;
}

export interface DiscoverOpenAICompatibleModelsInput {
  apiBase: string;
  apiKey: string;
}

type ModelDiscoveryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscoverOpenAICompatibleModelsOptions {
  fetchImpl?: ModelDiscoveryFetch;
  timeoutMs?: number;
}

export class ModelDiscoveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

/**
 * Reads the OpenAI-compatible `GET {apiBase}/models` endpoint without
 * persisting the credentials or the resulting model list.
 */
export async function discoverOpenAICompatibleModels(
  input: DiscoverOpenAICompatibleModelsInput,
  options: DiscoverOpenAICompatibleModelsOptions = {},
): Promise<DiscoveredOpenAICompatibleModel[]> {
  const endpoint = buildModelsEndpoint(input.apiBase);
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new ModelDiscoveryError("请填写 API 密钥后再获取模型列表", 422);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw upstreamResponseError(response.status);
    }

    const responseText = await readResponseText(response);
    return parseOpenAICompatibleModels(responseText);
  } catch (error) {
    if (error instanceof ModelDiscoveryError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new ModelDiscoveryError("获取模型列表超时，请稍后重试", 504);
    }

    throw new ModelDiscoveryError("无法连接到 API Base，请检查地址和网络", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function buildModelsEndpoint(apiBase: string): string {
  const value = apiBase.trim();
  if (!value) {
    throw new ModelDiscoveryError("请填写 API Base 后再获取模型列表", 422);
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new ModelDiscoveryError("API Base 必须是有效的 HTTP 地址", 422);
  }

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new ModelDiscoveryError("API Base 仅支持 HTTP 或 HTTPS 地址", 422);
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new ModelDiscoveryError("API Base 不能包含账号、查询参数或片段", 422);
  }

  const normalizedBase = baseUrl.href.endsWith("/")
    ? baseUrl.href
    : `${baseUrl.href}/`;
  return new URL("models", normalizedBase).href;
}

function upstreamResponseError(status: number): ModelDiscoveryError {
  if (status === 401 || status === 403) {
    return new ModelDiscoveryError(
      "API 密钥无效，或没有读取模型列表的权限",
      401,
    );
  }
  if (status === 404) {
    return new ModelDiscoveryError(
      "该 API Base 不支持 OpenAI-compatible 的 /models 接口",
      404,
    );
  }

  return new ModelDiscoveryError(`获取模型列表失败（HTTP ${status}）`, 502);
}

async function readResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new ModelDiscoveryError("模型列表响应过大，无法处理", 502);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new ModelDiscoveryError("模型列表响应过大，无法处理", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function parseOpenAICompatibleModels(
  responseText: string,
): DiscoveredOpenAICompatibleModel[] {
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new ModelDiscoveryError("模型列表接口返回了无法解析的数据", 502);
  }

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ModelDiscoveryError(
      "该接口未返回 OpenAI-compatible 的模型列表",
      502,
    );
  }

  const models = new Map<string, DiscoveredOpenAICompatibleModel>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      continue;
    }

    const id = item.id.trim();
    const name = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : id;
    models.set(id, { id, name });
  }

  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
