import { Elysia } from "elysia";
import { detailError } from "../core/errors";
import {
  projectRunSnapshot,
  projectPermissionSnapshot,
  type Event,
  type Permission,
  type PermissionId,
  type Run,
  type RunId,
  type TraceEvent,
} from "../runtime";

export interface RuntimeRunReadStore {
  getRun(id: RunId): Run | null;
  listEventsByRun(runId: RunId): Event[];
  listTraces(runId: RunId): TraceEvent[];
  getPermission(id: PermissionId): Permission | null;
  getPermissionByAiSdkApprovalId(approvalId: string): Permission | null;
}

export interface RunHistoryRouteDeps {
  runtimeStore: RuntimeRunReadStore | null;
}

export function runHistoryRoutes(deps: RunHistoryRouteDeps) {
  return new Elysia({ prefix: "/v1", name: "run-history-routes" })
    .get("/runs/:runId", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const run = store.getRun(params.runId as RunId);
      if (!run) {
        return detailError(404, `Run ${params.runId} not found`);
      }

      return { run: projectRunSnapshot(run) };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "获取 Runtime Run 当前快照",
        description: "返回一次 Runtime Run 的当前状态、输入输出、usage、limits 和 metadata。",
        parameters: [runIdParameter],
      },
    })
    .get("/runs/:runId/events", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const run = store.getRun(params.runId as RunId);
      if (!run) {
        return detailError(404, `Run ${params.runId} not found`);
      }

      return {
        run_id: run.id,
        events: store.listEventsByRun(run.id),
      };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "获取 Runtime Run 事件",
        description: "返回某次 Run 已持久化的 durable semantic events，不包含 token delta。",
        parameters: [runIdParameter],
      },
    })
    .get("/runs/:runId/traces", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const run = store.getRun(params.runId as RunId);
      if (!run) {
        return detailError(404, `Run ${params.runId} not found`);
      }

      return {
        run_id: run.id,
        traces: store.listTraces(run.id),
      };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "获取 Runtime Run traces",
        description: "返回某次 Run 的 trace timeline，用于调试和诊断。",
        parameters: [runIdParameter],
      },
    })
    .get("/permissions/:permissionId", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const permission = store.getPermission(params.permissionId as PermissionId);
      if (!permission) {
        return detailError(404, `Permission ${params.permissionId} not found`);
      }
      return { permission: projectPermissionSnapshot(permission) };
    }, {
      detail: {
        tags: ["运行"],
        summary: "获取 Permission 快照",
        description:
          "按 Runtime Permission ID 返回持久化审批快照，用于审批 UI 与刷新恢复。",
      },
    })
    .get("/tool-approvals/:approvalId/permission", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const permission = store.getPermissionByAiSdkApprovalId(params.approvalId);
      if (!permission) {
        return detailError(404, `Tool approval ${params.approvalId} not found`);
      }
      return { permission: projectPermissionSnapshot(permission) };
    }, {
      detail: {
        tags: ["运行"],
        summary: "解析 AI SDK approval 对应的 Permission",
        description:
          "只读解析实时流中的 AI SDK approval ID，决策提交仍只接受 Runtime Permission ID。",
      },
    });
}

const runIdParameter = {
  name: "runId",
  in: "path" as const,
  required: true,
  description: "Runtime run id。",
  schema: { type: "string" },
} as const;

function requireStore<TStore>(store: TStore | null): TStore | Response {
  return store ?? detailError(503, "Runtime Store not initialized");
}
