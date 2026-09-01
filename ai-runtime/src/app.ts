import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { createRuntimeLogger, type RuntimeLogger } from "./core/logger";
import {
  createRuntimeAccessAuth,
  isProtectedRuntimePath,
  unauthorizedRuntimeResponse,
} from "./auth/runtime-access-auth";
import type { RuntimeConfig } from "./config";
import { CatalogService, type RawCatalog } from "./provider/catalog";
import { type discoverOpenAICompatibleModels } from "./provider/model-discovery";
import { type testOpenAICompatibleToolCalling } from "./provider/tool-call-compatibility";
import { ProviderService } from "./provider/service";
import { agentModeRoutes } from "./routes/agent-modes";
import { conversationRoutes } from "./routes/conversations";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { providerRoutes } from "./routes/providers";
import { runHistoryRoutes } from "./routes/run-history";
import { runRoutes } from "./routes/runs";
import { runtimeSettingsRoutes } from "./routes/settings";
import {
  RuntimeEventBus,
  RuntimeSqliteStore,
  ActiveRunRegistry,
  RunContinuationRegistry,
  PreparedToolInvocationRegistry,
  repairActiveStoredRuns,
  type RuntimeEventBus as RuntimeEventBusType,
  type RuntimeResolvedLanguageModel,
  type RuntimeStreamText,
  RuntimeToolRegistry,
  createConversationTitleGenerator,
  createBackendBridgeToolExecutor,
  createConnectionToolNamespace,
  createKeyValueToolNamespace,
  createMetadataToolNamespace,
  createSqlToolNamespace,
  createSystemToolNamespace,
  createTableToolNamespace,
  createWebToolNamespace,
  type ConversationTitleTextGenerator,
} from "./runtime";
import { openRuntimeDatabase, type RuntimeDatabase } from "./storage/runtime-database";
import { APP_VERSION } from "./version";
import { BackendBridgeManager, backendBridgeRoutes } from "./backend-bridge";
import { RuntimeSettingsService } from "./settings/service";

const ALLOWED_CORS_ORIGIN_REGEX =
  /^(tauri:\/\/localhost|https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?)$/;
const ALLOWED_CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALLOWED_CORS_REQUEST_HEADERS = [
  "Accept",
  "Authorization",
  "Cache-Control",
  "Content-Type",
];
const EXPOSED_CORS_RESPONSE_HEADERS = [
  "X-Nexus-Conversation-Id",
  "X-Nexus-Message-Id",
  "X-Nexus-Run-Id",
];

export interface AppFactoryDeps {
  fetchCatalog?: () => Promise<RawCatalog | null>;
  discoverOpenAICompatibleModels?: typeof discoverOpenAICompatibleModels;
  testOpenAICompatibleToolCalling?: typeof testOpenAICompatibleToolCalling;
  logger?: RuntimeLogger;
  runtimeDatabase?: RuntimeDatabase;
  runtimeEventBus?: RuntimeEventBusType | null;
  resolveLanguageModel?: (input: {
    providerId: string;
    modelId: string;
  }) => RuntimeResolvedLanguageModel;
  streamText?: RuntimeStreamText;
  generateConversationTitleText?: ConversationTitleTextGenerator;
  toolRegistry?: RuntimeToolRegistry;
  backendBridge?: BackendBridgeManager;
  runtimeSettingsService?: RuntimeSettingsService;
}

type AppRuntimeConfig = Omit<
  RuntimeConfig,
  "accessToken" | "runtimeSettingsPath" | "cacheDir"
> &
  Partial<Pick<RuntimeConfig, "accessToken" | "runtimeSettingsPath" | "cacheDir">>;

export async function createApp(config: AppRuntimeConfig, deps: AppFactoryDeps = {}) {
  const logger = deps.logger ?? createRuntimeLogger({ level: "silent" });
  const runtimeAccessAuth = createRuntimeAccessAuth(config.accessToken ?? null);
  const backendBridge = deps.backendBridge ?? new BackendBridgeManager({ logger });
  const startedAtByRequest = new WeakMap<Request, number>();
  const catalog = config.dataDir
    ? new CatalogService({ catalogPath: config.catalogPath, fetchCatalog: deps.fetchCatalog })
    : null;
  const providerService = catalog
    ? new ProviderService({ catalog, providersPath: config.providersPath })
    : null;

  if (providerService) {
    await providerService.initialize();
    if (providerService.hasStaleCatalogCache()) {
      void providerService.refreshCatalog(false).then((result) => {
        if (result.status === "updated") {
          logger.info(
            { lastUpdatedAt: result.lastUpdatedAt },
            "provider catalog refreshed in background",
          );
          return;
        }

        logger.warn(
          { status: result.status, lastUpdatedAt: result.lastUpdatedAt },
          "provider catalog background refresh failed; using cached catalog",
        );
      }).catch((error: unknown) => {
        logger.warn({ err: error }, "provider catalog background refresh failed");
      });
    }
  }
  const runtimeSettingsService =
    deps.runtimeSettingsService ??
    new RuntimeSettingsService({
      settingsPath: config.runtimeSettingsPath ?? "",
      logger,
    });
  runtimeSettingsService.initialize();

  const ownsRuntimeDatabase = !deps.runtimeDatabase && Boolean(config.runtimeDbPath);
  const runtimeDatabase =
    deps.runtimeDatabase ??
    (ownsRuntimeDatabase
      ? openRuntimeDatabase(config.runtimeDbPath, { logger })
      : null);
  const runtimeEventBus = deps.runtimeEventBus === undefined
    ? new RuntimeEventBus()
    : deps.runtimeEventBus;
  const runtimeStore = runtimeDatabase
    ? new RuntimeSqliteStore(runtimeDatabase, { eventBus: runtimeEventBus ?? undefined })
    : null;
  const generateConversationTitle = runtimeStore
    ? createConversationTitleGenerator({
        store: runtimeStore,
        logger,
        generateText: deps.generateConversationTitleText,
      })
    : undefined;
  const activeRuns = new ActiveRunRegistry();
  const continuations = new RunContinuationRegistry();
  const repairedRuns = runtimeStore ? repairActiveStoredRuns({ store: runtimeStore }) : [];
  if (repairedRuns.length > 0) {
    logger.warn(
      {
        count: repairedRuns.length,
        runIds: repairedRuns.map((result) => result.run.id),
      },
      "repaired stale runtime runs",
    );
  }
  const toolRegistry =
    deps.toolRegistry ??
    new RuntimeToolRegistry([
      createConnectionToolNamespace(),
      createMetadataToolNamespace(),
      createSqlToolNamespace(),
      createTableToolNamespace(),
      createKeyValueToolNamespace(),
      createSystemToolNamespace(),
      createWebToolNamespace({ logger }),
    ]);
  const backendToolExecutor = createBackendBridgeToolExecutor(backendBridge);
  const preparedInvocations = new PreparedToolInvocationRegistry();

  return new Elysia()
    .use(
      openapi({
        path: "/docs",
        specPath: "/docs/json",
        documentation: {
          info: {
            title: "NexusPilot AI Runtime 接口文档",
            version: APP_VERSION,
            description: "NexusPilot Bun AI sidecar 的本地接口文档。",
          },
          tags: [
            { name: "健康检查", description: "Runtime 健康状态与版本信息" },
            {
              name: "供应商与模型",
              description: "Provider/model 目录、配置和自定义供应商管理",
            },
            {
              name: "对话与历史",
              description: "Runtime 对话、消息历史、Run、Event 和 Trace 读取接口",
            },
            {
              name: "事件",
              description: "AI Runtime live-only EventBus 与 scoped SSE 接口",
            },
            {
              name: "智能体模式",
              description: "内置 Agent Mode 的只读 UI catalog",
            },
            { name: "运行", description: "AI Runtime Run 创建与执行接口" },
            {
              name: "运行时设置",
              description: "AI Runtime 权威偏好与工具审批策略",
            },
          ],
        },
      }),
    )
    .onRequest(({ request }) => {
      startedAtByRequest.set(request, performance.now());
    })
    .onAfterHandle(({ request, set }) => {
      const url = new URL(request.url);
      const startedAt = startedAtByRequest.get(request) ?? performance.now();
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const status = typeof set.status === "number" ? set.status : 200;

      logger.info(
        {
          method: request.method,
          path: url.pathname,
          status,
          durationMs,
        },
        "request completed",
      );
    })
    .onError(({ request, error, set }) => {
      const url = new URL(request.url);
      const startedAt = startedAtByRequest.get(request) ?? performance.now();
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const status = typeof set.status === "number" ? set.status : 500;

      logger.error(
        {
          err: error,
          method: request.method,
          path: url.pathname,
          status,
          durationMs,
        },
        "request failed",
      );
    })
    .use(
      cors({
        origin: ({ headers }) => {
          const origin = headers.get("origin");
          return origin !== null && ALLOWED_CORS_ORIGIN_REGEX.test(origin);
        },
        credentials: true,
        methods: ALLOWED_CORS_METHODS,
        allowedHeaders: ALLOWED_CORS_REQUEST_HEADERS,
        exposeHeaders: EXPOSED_CORS_RESPONSE_HEADERS,
        maxAge: 600,
      }),
    )
    .onRequest(({ request }) => {
      const pathname = new URL(request.url).pathname;
      if (
        isProtectedRuntimePath(pathname) &&
        !runtimeAccessAuth.authorizeRequest(request)
      ) {
        return unauthorizedRuntimeResponse();
      }
    })
    .decorate("runtimeStore", runtimeStore)
    .onStop(() => {
      backendBridge.shutdown();
      preparedInvocations.clearAll();
      if (ownsRuntimeDatabase) {
        runtimeStore?.close();
      }
    })
    .use(healthRoutes(backendBridge))
    .use(backendBridgeRoutes(backendBridge))
    .use(providerRoutes({
      providerService,
      catalog,
      discoverOpenAICompatibleModels: deps.discoverOpenAICompatibleModels,
      testOpenAICompatibleToolCalling: deps.testOpenAICompatibleToolCalling,
    }))
    .use(runtimeSettingsRoutes(runtimeSettingsService))
    .use(agentModeRoutes())
    .use(conversationRoutes({
      runtimeStore,
      activeRuns,
      backendToolExecutor,
      preparedInvocations,
    }))
    .use(runHistoryRoutes({ runtimeStore }))
    .use(eventRoutes({ eventBus: runtimeEventBus }))
    .use(
      runRoutes({
        providerService,
        runtimeStore,
        resolveLanguageModel: deps.resolveLanguageModel,
        streamText: deps.streamText,
        generateConversationTitle,
        toolRegistry,
        backendToolExecutor,
        preparedInvocations,
        backendBridgeState: () => backendBridge.snapshot().state,
        activeRuns,
        continuations,
        getToolApprovalPolicy: () =>
          runtimeSettingsService.snapshot().toolPolicy,
        getNetworkPolicy: () => runtimeSettingsService.snapshot().networkPolicy,
        appVersion: APP_VERSION,
      }),
    );
}
