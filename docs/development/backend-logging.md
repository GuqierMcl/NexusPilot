# Backend Logging Guide

本指南约束 NexusPilot Rust 后端日志的使用方式。目标是让数据库驱动、runtime manager 和 IPC command 在真实环境出错时留下足够上下文，同时不泄露连接凭据。

## 日志依赖

后端统一使用 `tauri-plugin-log`，不要在 engine、sidecar lifecycle、单实例或其他生产路径中新增 `println!` / `eprintln!` / 临时文件写入作为诊断方案。所有需留存的日志都必须通过 Rust logger 路由。

初始化位置为 `src-tauri/src/lib.rs`。日志策略按构建环境区分：

| 环境 | 等级 | 输出 | 持久化 |
| --- | --- | --- | --- |
| Debug / 开发 | `Debug` | stdout（彩色） | 不写文件 |
| Release / 生产 | `Info` | stdout + 两个 app log 文件 | 写文件 |

生产环境的 Windows 文件日志位于 `%LOCALAPPDATA%/<bundle identifier>/logs/`。NexusPilot 当前 bundle identifier 为 `NexusPilot`，文件分别为：

```text
%LOCALAPPDATA%\NexusPilot\logs\
├── nexuspilot.log  # Tauri / Rust 主进程日志
└── ai-runtime.log  # 由 Tauri 接管并转写的 AI Runtime sidecar 日志
```

两个生产日志都使用追加写入、单个活动文件最大 2 MiB、`KeepSome(7)` 轮转策略。`KeepSome(7)` 表示保留当前文件与 7 个历史归档文件，单类日志最多约 16 MiB。开发环境不创建这些日志文件。

AI Runtime 在生产环境被注入 JSON 输出格式；Tauri 根据 Pino JSON 中的 level 保留原始严重程度，并用 `nexuspilot::ai_runtime` target 将记录只写入 `ai-runtime.log`。sidecar stderr、shell event error 和非零退出会以 `warn` 或 `error` 写入同一文件。

## 日志级别

| Level | 使用场景 |
| --- | --- |
| `error` | 用户操作失败、数据库 SQL 执行失败、连接中断、提交失败、事务提交/回滚失败等需要开发者追踪的主失败。 |
| `warn` | 清理路径失败，但主失败已经被保留。例如 DML 失败后的 rollback 失败、SQL editor schema reset 失败。 |
| `info` | 生命周期信息、未来需要时的关键状态变化。不要把高频 row-level 数据写成 info。 |
| `debug` / `trace` | 仅开发构建默认打开；生产环境默认不写入。如后续需要临时提高生产诊断等级，必须先确认不会输出凭据或大对象内容。 |

开发环境的 stdout 颜色约定由 `fern::colors::ColoredLevelConfig::new()` 提供默认值：`ERROR` 为红色，`WARN` 为黄色，`INFO` 为白色，`DEBUG` 为蓝色，`TRACE` 为 bright black。颜色只用于调试可读性，不得作为日志解析依据。

## Engine 统一错误日志

`ConnectionRuntimeManager` 调用驱动 trait 时，如果驱动返回 `IpcError`，必须通过 `src-tauri/src/engine/diagnostics.rs` 记录统一 engine error：

```rust
diagnostics::log_engine_error(
    "commit_table_change_set",
    profile_id,
    Some(tab_id),
    driver.as_ref(),
    Some(container),
    &error,
);
```

统一日志字段：

| 字段 | 说明 |
| --- | --- |
| `operation` | 稳定操作名，通常等于 IPC command 或驱动内部步骤名。 |
| `driver` | 小写 driver key，例如 `oracle`、`mysql`、`postgres`、`redis`。 |
| `profile_id` | 连接 profile id，用于和前端 tab / session 对齐。 |
| `tab_id` | 可选 tab runtime id；shared runtime 操作为 `none`。 |
| `container` | 可选 `ContainerRef` 摘要，只包含 kind/database/schema/table/key 等寻址信息。 |
| `code` | `IpcErrorCode`。 |
| `message` | 面向用户的错误消息。 |
| `details` | 面向开发者的底层细节。 |

统一日志不改变 IPC 返回值。前端仍只接收结构化 `IpcError`，日志只用于本地诊断和问题复盘。

## 驱动低层日志

驱动可以在统一 manager 日志之外记录低层失败，前提是这些日志能帮助定位真实数据库兼容问题。例如 Oracle driver 记录：

- DataTable 元数据查询失败：`operation=oracle_load_table_columns_base_meta` 等。
- DML statement 执行失败：`operation=oracle_dml_execute`。
- DML 失败后的 rollback 清理失败：`operation=oracle_dml_rollback_after_failure`，使用 `warn`。
- SQL editor 设置 / 重置 current schema 失败。
- 用户显式 SQL 执行失败，记录截断后的 SQL 片段。

低层 SQL 日志必须满足：

- SQL 片段来自后端生成语句或用户显式 SQL，使用 `diagnostics::truncate_for_log` 截断。
- 默认截断上限为 `MAX_LOG_SNIPPET_CHARS = 2048`。
- 不记录密码、连接 payload、SSH 私钥、host key secret、完整 `.env.test` 内容或 token。
- 不记录完整 LOB、大结果集、行数据 dump 或二进制内容。
- 清理失败使用 `warn`，不要覆盖主失败。

## 新增后端日志检查清单

新增数据库驱动、IPC command 或跨模块 engine 行为时，按以下顺序检查：

1. 用户会看到的失败继续返回结构化 `IpcError`。
2. manager 层为 trait 调用失败记录统一 engine error。
3. 驱动内部只在能补充上下文时增加低层日志。
4. 日志字段使用稳定英文 `operation` 名，方便搜索。
5. 任意用户输入 SQL、对象名、错误 details 都要截断。
6. 凭据和连接配置永远不能进入日志。
7. 验证失败路径时，优先用真实数据库集成测试复现，而不是只看 mock 或 unit test。
