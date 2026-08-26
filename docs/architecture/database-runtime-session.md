# 数据库运行时会话语义

> 本文档定义 NexusPilot 跨数据库驱动通用的“数据库运行时会话（Database Runtime Session）”语义。它约束当前 Connection Runtime 和后续数据库驱动的生命周期设计。具体代码结构与当前已实现 capability 见 [connection-runtime.md](./connection-runtime.md)。

---

## 1. 为什么不用“物理连接”或“逻辑连接”

数据库客户端并不总能用“一条常驻 socket”解释：

- PostgreSQL、MySQL 等驱动通常持有连接池，池内连接会创建、回收和重建；
- ClickHouse HTTP/HTTPS 客户端持有可复用 transport 和连接池，但不承诺某条 TCP socket 常驻；
- Redis、云 API、无状态 SDK、代理和未来 serverless 数据源可能采用完全不同的 transport；
- SSH tunnel、TLS session、HTTP keep-alive 和数据库 session 都是驱动内部资源，不能直接等同产品层连接状态。

因此，NexusPilot 统一使用**数据库运行时会话**描述产品层状态：

> 一个已保存的连接配置已经被物化为可工作的运行时；系统完成了必要的真实远端探测，持有后续操作所需的驱动资源、能力快照和生命周期边界，并允许加载远程资源。

代码中的 `ConnectionRuntimeManager`、shared runtime 和 tab runtime 保留现有命名；文档和产品语义不再把它们解释为“某条物理连接”。“逻辑连接”和“虚拟连接”也不作为正式术语，因为它们没有说明运行时资源、健康状态和远程数据边界。

---

## 2. 四层边界

| 层次 | 事实来源 | 生命周期 | 职责 |
| --- | --- | --- | --- |
| A 域：Stored Connection Profile | 本地 SQLite | 持久化 | 保存连接名称、driver、endpoint、凭据配置、环境、标签和 payload；不证明远端可达 |
| Profile Shared Runtime | Rust `ConnectionRuntimeManager.shared` | 显式连接到断开/进程退出 | 持有驱动 client/pool、可选 tunnel、能力和健康快照；承载 Explorer、ping 和共享只读操作 |
| Tab Runtime | Rust `ConnectionRuntimeManager.tabs` + 前端 tab state | 内容 tab 打开到关闭 | 隔离 SQL query id、取消句柄、事务或 mutation watch、执行上下文和 tab 专属资源 |
| Remote State Cache | TanStack Query / Explorer metadata store | 已连接期间按需加载 | 缓存 databases、schemas、tables、columns、parts、mutations 等远端事实；不是连接状态本身 |

必须保持以下不变量：

1. A 域 profile 存在不代表数据库运行时会话已建立。
2. 应用重启后，已保存 profile 默认回到 `idle`，不能从持久化数据恢复为 `connected`。
3. 只有真实远端探测成功后才能注册 shared runtime 并进入 `connected`。
4. `connected` 不承诺某条 socket 常驻，只承诺 runtime 已建立且最近健康判断成功。
5. 远程 metadata 只能在 runtime 允许访问时加载；它由缓存层维护，不塞入连接 session store。
6. 显式断开必须取消仍在构造中的 shared/tab runtime、释放已注册 runtime、停止本地观察任务，并以 cancel + remove 清理该 profile 的远程缓存；不得删除 A 域 profile。
7. 服务端长任务可能独立于客户端 runtime 存活。断开只能停止本地请求或轮询，不能虚构服务端 mutation/job 已取消。

---

## 3. 建立运行时会话

`connect_profile` 不是“new client 成功”就完成。驱动必须完成与自身 transport 相符的真实验证：

```text
idle / error
  -> connecting
  -> 读取并解析 Stored Connection Profile
  -> 建立或解析 transport 资源（pool / HTTP client / SSH tunnel / TLS）
  -> 执行真实远端健康探测
  -> 读取服务端版本和必要能力/权限
  -> 创建 DriverCapabilities 与健康快照
  -> 注册 Profile Shared Runtime
  -> connected
```

建连和断开是同一 profile 下的并发生命周期操作，不能只在前端隐藏迟到结果。前端为每轮初始 connect 分配 attempt identity，断开或新一轮 connect 会使旧结果失效；Rust Manager 同时为 shared/tab construction 分配单调 attempt id 与取消信号。driver 创建完成后，Manager 必须在持有 attempt 锁时再次确认该代仍是 current，并与 runtime map 写入形成同一个注册临界区。断开会先移除 attempt 并发出取消信号，因此尚未注册的 driver construction future 会被释放，迟到 driver 也只能关闭后返回 `OPERATION_CANCELED`，不能产生 zombie runtime。

惰性 client 构造、URL 语法通过或本地 payload 反序列化成功，都不能单独作为 `connected` 的依据。驱动的最小真实探测示例：

| 驱动形态 | 最小探测 |
| --- | --- |
| PostgreSQL / MySQL / Oracle / SQLite | 获取连接并执行 driver ping/轻量查询 |
| Redis | `PING` |
| ClickHouse HTTP/HTTPS | `SELECT 1`，并读取 `version()` 与必要 system 表权限 |
| 云 API / serverless 数据源 | 调用低风险 authenticated health/list endpoint |

探测成功后注册的 runtime 应持有后续请求需要复用的资源。ClickHouse 即使不拥有常驻 socket，也会持有官方 client、HTTP pool、endpoint、可选 tunnel、能力和健康快照，因此 runtime 不是无意义的 UI 状态。

---

## 4. 通用连接状态模型

### 4.1 当前实现

前端已经以跨驱动纯 reducer 实现七态数据库运行时会话。它同时服务连接池、HTTP、云 API、SSH tunnel 和未来驱动：

```text
idle
  -> connecting
  -> connected
  -> degraded
  -> reconnecting
  -> connected

connecting -> error
degraded/reconnecting -> error
connecting/connected/degraded/reconnecting/error -> disconnecting -> idle
error -> connecting
```

`isRuntimeMaterialized()` 把 `connected/degraded/reconnecting` 视为仍持有 runtime；只有 `connected + schemaBrowser=true` 允许发起新的 Explorer metadata 请求。`degraded/reconnecting` 保留最近成功的远程缓存，不把失败误写成空树，也不会再次调用 `connect_profile`。

### 4.2 状态语义

| 状态 | 通用语义 |
| --- | --- |
| `idle` | 只有 A 域 profile，没有可用 runtime |
| `connecting` | 正在创建 runtime 并执行首次真实探测 |
| `connected` | runtime 已注册，最近健康判断成功，允许远程读写能力按 capability 工作 |
| `degraded` | runtime 仍在，但最近发生 transport/health 异常；缓存可保留，写操作默认暂停 |
| `reconnecting` | 正在执行有上限、可观察的恢复探测；不得无限静默重试 |
| `error` | 首次连接失败，或恢复策略耗尽后确认 runtime 不可用 |
| `disconnecting` | 正在停止本地请求/轮询、关闭 tab runtime、释放 tunnel/client 并清理缓存 |

该状态机是通用能力，公共 session store 没有 `if (driver === "clickhouse")`。状态转换、错误分类、恢复协调器、Explorer 准入和 UI 展示均对其他驱动开放复用。

---

## 5. 错误如何影响状态

一次业务请求失败不等于整个运行时会话失效。驱动或 Manager 必须把业务错误与 transport/health 错误分开：

| 错误 | 默认状态影响 |
| --- | --- |
| SQL 语法、输入校验 | 保持 `connected` |
| 对象不存在 | 保持 `connected`，使相关 metadata cache 失效 |
| 单个资源权限不足 | 保持 `connected`，更新资源能力或返回操作错误 |
| 用户主动取消 | 保持当前健康状态 |
| 单个业务操作 timeout | `runtimeImpact=businessOnly`，保持当前 runtime health |
| 单次 network/TLS/HTTP transport 错误 | 进入 `degraded` 并触发有限探测 |
| 凭据被拒绝或 token 失效 | 进入 `error` |
| SSH tunnel 中断 | `degraded -> reconnecting -> connected/error` |
| 连续健康探测失败 | 进入 `error` |
| 用户显式断开 | `disconnecting -> idle` |

后端 `IpcError.runtimeImpact` 显式区分 `businessOnly/retryable/terminal`；前端不通过错误码或 driver name 猜测健康影响。当前通用恢复策略固定为最多 3 次探测，延迟依次为 `0/500/1500ms`。同一 profile 同时只允许一个 recovery coordinator，重复 transport failure 复用同一 Promise；显式 disconnect 会先取消 coordinator 与前端状态写入，并由后端 `close()`/attempt cancellation 终止仍在执行的健康探测或 driver construction。迟到的 connect/probe result 不能复活已断开的 session。恢复过程中展示 `degraded -> reconnecting (attempt/maxAttempts) -> connected/error`，且 `connecting/degraded/reconnecting/error` 都保留显式关闭入口。

---

## 6. Remote State Cache 语义

`connected` 是远程请求的准入条件，不是 metadata 容器。远程数据继续由 TanStack Query 和 Explorer metadata store 管理：

- query key 以 profile id 为根，支持业务变更后的精确 invalidate，以及显式断开时的 `cancelQueries + removeQueries`；断开不得用 invalidate 触发已失效数据重取；
- Explorer 节点按展开懒加载，不能在连接成功时一次抓取全部对象；
- schema/table mutation 成功后精确 invalidate 受影响范围；
- `degraded` 时可以保留并展示最近成功缓存，但必须显示可能陈旧的状态；
- degraded 请求失败不能用空数组覆盖最近成功缓存；
- 恢复 `connected` 后重新验证关键 metadata；
- 显式断开、profile endpoint/credential 改变时清理该 profile 的远程缓存。

Zustand connection session 只保存生命周期、健康摘要、active context 和 capabilities，不保存大型 metadata 树。

---

## 7. Shared Runtime 与 Tab Runtime

Shared runtime 面向 profile 级共享操作：

- Explorer metadata；
- ping / health probe；
- capability 和 server version；
- 不需要 tab 身份的低风险读操作。

Tab runtime 面向工作面隔离。它不要求独占 socket，但必须为以下资源提供稳定身份和清理边界：

- SQL query id、进度、取消 handle；
- DataTable transaction/pinned connection（驱动支持时）；
- ClickHouse mutation watch、query profile 和执行快照；
- 临时 session settings 或未来需要的 driver-specific state。

HTTP client clone 共享连接池不削弱 tab runtime 的意义。tab runtime 隔离的是用户操作和可取消任务，不是 transport socket。

---

## 8. 新驱动准入检查

接入任何新数据库前必须回答：

1. 哪些字段属于 A 域 profile？
2. `connect_profile` 的真实健康探测是什么？
3. shared runtime 持有哪些 client/pool/tunnel/credential refresh 资源？
4. 哪些操作需要 tab runtime，以及它们如何取消和清理？
5. 哪些错误影响业务请求，哪些错误影响 runtime health？
6. `degraded/reconnecting` 是否可用，恢复策略是否有限且可观察？
7. 哪些远程信息进入 TanStack Query，断开和 mutation 后如何失效？
8. 服务端长任务能否独立存活，重连后如何重新发现？
9. capabilities 是连接级、资源级还是操作级，前端如何组合？
10. profile 的 `Debug`、诊断日志和 endpoint 展示是否对数据库/SSH 凭据脱敏，host 是否在任何网络或 tunnel 动作前按“纯主机名/IP”校验？

驱动可以新增专属 capability、IPC 和内容 tab，但公共状态机、缓存边界和 runtime 生命周期不得被驱动专属分支污染。

---

## 9. ClickHouse 作为首个 HTTP 形态驱动

ClickHouse 使用 HTTP/HTTPS 作为主协议，但仍完整遵守数据库运行时会话语义：

- Phase 1 已接入官方 `clickhouse` Rust client，使用 rustls 与系统原生根证书，不提供跳过 TLS hostname/certificate 验证的选项；
- `test_connection_config`、`connect_profile` 和 `open_tab_runtime` 构造 client 后，依次通过有界的 `SELECT toUInt8(1)`、`version()` 和 `system.databases` 权限探测，才返回可注册 runtime；
- `SELECT 1` 或版本探测失败不会留下 shared/tab runtime；system catalog 权限拒绝只记录 `system_catalog_access=false`，network/auth/timeout/decoding 失败仍会终止连接；
- shared/tab runtime 持有 ClickHouse client、HTTP pool、endpoint、cached server version、system catalog access 观察值和可选 SSH tunnel；`ping()` 每次执行真实 `SELECT 1`，`close()` 会通知并终止仍在执行的 ping；
- direct HTTP、direct HTTPS 与 ClickHouse Cloud credentials 使用原始 hostname；HTTP + SSH 使用解析后的 loopback endpoint 并由 driver 保持 tunnel 生命周期；HTTPS + SSH 在当前 tunnel 无法保持原始 SNI 的情况下于 endpoint resolution 前 fail closed；
- profile host 在 endpoint resolution、SSH 或网络动作前只接受安全 ASCII hostname、IPv4 或 IPv6，不接受 URL scheme、userinfo、端口、path/query/fragment 或 authority 元字符；IPv6 endpoint 统一加方括号；ClickHouse profile 的数据库密码和 SSH secret 在 `Debug` 输出中统一脱敏；
- Phase 1 的 `DriverCapabilities` 全部为 `false`，尚不实现 `SchemaBrowser`、`SqlExecutor`、DataTable 或 mutation capability；因此连接成功不会触发 Explorer metadata 请求；
- query id、进度、取消和 mutation watch 进入 tab runtime 或专属观察 runtime；
- `system.mutations` 中的服务端任务不依赖本地 runtime 生命周期，重连后可以重新发现；
- HTTP keep-alive socket 是否存在是 client 内部细节，不改变状态机。

Phase 1 的 real smoke 已有默认禁用、不会联网的门控契约；2026-07-12 已取得 self-hosted HTTP（ClickHouse `26.5.1.882`）真实连接证据。后续 Explorer、查询、Schema Design、DataTable CRUD 与基础版发布门禁均已完成，单节点 HTTP/IP:PORT 当前为 `available`。Cloud HTTPS、TLS/SNI、SSH 与其他部署形态仍需各自的真实兼容性门禁，不会因基础版发布而自动进入公开支持矩阵。

当前支持边界见 [ClickHouse support](../product/database-support/clickhouse.md)。
