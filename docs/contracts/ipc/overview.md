# Nexus Pilot: IPC 通信协议与错误处理规范

## 1. 目标与边界

Nexus Pilot 的前端通过 Tauri IPC 调用 Rust 后端。当前 IPC 分为以下边界：

- **Engine IPC**：数据库运行时会话、元数据加载、表数据浏览、Redis key 浏览、事务与运行时 tab 等命令。必须使用 `src/lib/api-client.ts` 的 `apiInvoke()`。
- **Storage IPC**：本地 SQLite 连接配置、文件夹与保存查询 CRUD。继续使用直接 `invoke` 的专用封装，例如 `src/lib/tauri/connections.ts` 与 `src/lib/tauri/saved-queries.ts`，不纳入 Engine IPC 统一错误处理。
- **App Identity IPC**：应用安装级只读信息，例如匿名安装标识。继续使用直接 `invoke` 的专用封装，不访问外部网络、不修改业务状态，也不纳入 Engine IPC 统一 toast/error 体系。
- **Auth IPC**：可选账号登录的脱敏会话投影与用户动作。使用 `src/features/account/auth-client.ts` 的专用直接 `invoke` 封装；不返回 Token，不进入数据库 runtime health，也不使用 Engine 默认 toast/error 体系。
- **Cloud IPC**：由 Rust 携带 NIEEX Account Token 调用 NexusPilot Cloud 后返回的脱敏业务投影。使用 `src/lib/tauri/cloud.ts` 的专用直接 `invoke` 封装；Authorization Header、JWT 和原始 Claim 不进入 IPC，也不影响本地数据库 runtime health。

统一处理的目标是让 Engine IPC 的业务代码不直接接触原始 Tauri rejection，而是统一拿到结构化 `IAppError`，并复用同一套 toast、inline message、retry policy。

### 1.1 Auth IPC 安全契约

认证 command 固定为：

```text
get_auth_snapshot
get_auth_avatar
start_auth_sign_in
cancel_auth_sign_in
retry_auth_session
sign_out_auth_session
```

Rust 通过 `auth-session-changed` 发布与 command 返回同形的 `AuthSessionSnapshot`。前端启动顺序必须是先订阅事件、再调用 `get_auth_snapshot`；如果读取期间收到事件，保留事件中的较新 Snapshot。Auth Zustand Store 只驻留内存，不加入 Tauri Store/localStorage 持久化。

公开 Snapshot 只允许包含：

- `phase`: `restoring | anonymous | authenticated | reauthenticationRequired`；
- `operation`: `idle | signingIn | refreshing | signingOut`；
- Provider availability 与公开 Provider 摘要；
- 最小 `AuthUser`：Provider ID、Issuer、subject、昵称、Handle、邮箱、邮箱验证状态及可选本地 `avatarRevision`；
- 是否已有可用的 Rust 内存 Access Token，以及安全的过期/认证/刷新时间；
- 可展示的 `AuthPublicError { code, message, retryable, occurredAt }`。

`get_auth_avatar(revision)` 不返回 JSON，而是返回与当前已登录用户及 revision 精确绑定的本地净化 PNG 原始字节；已退出、revision 竞态、缓存缺失或校验失败均返回空字节并由 UI 降级为首字母。Tauri 当前原始响应应为 `ArrayBuffer`；前端在 IPC 边界仍防御性兼容 TypedArray 或字节数字数组，统一复制为 `Uint8Array` 后再创建 PNG Blob。该 command 不接受 URL、Issuer、subject 或文件路径，也不发起前端网络请求。

`sign_out_auth_session` 只执行本地退出：清空内存 Token、Pending Login、持久 Session 与当前头像缓存，并发布匿名 Snapshot。该 command 不访问 Revocation/End Session Endpoint、不打开系统浏览器、不触发 Post Sign-out Deep Link；网络或 Provider 状态不影响本地退出结果。

以下内容禁止进入任何 Auth IPC 参数、返回值、事件、React Store、Toast 或通用日志：Access Token、Refresh Token、ID Token 原文、Authorization Code、PKCE verifier、state、nonce、完整 Callback URL、原始 JWT Claims、Provider 原始 `picture` URL 和 Provider `error_description`。

Auth command 错误使用独立 `AuthPublicError`，不复用数据库 `IpcError`，也不影响任何 `ConnectionRuntimeManager` 状态。前端只展示 Rust 已脱敏的错误；非结构化 Tauri rejection 统一降级为 `AUTH_SYSTEM_INTERNAL`，不得把原始 rejection 直接显示给用户。登录、恢复、刷新和退出失败均不得阻止本地 SQLite、数据库工作台、设置或 AI Runtime。

### 1.2 Cloud IPC 安全契约

Phase 1 已开放账户 Bootstrap；Phase 8A 在同一 Rust 调用链上增加同步状态与设备投影读取 command：

```text
bootstrap_cloud_account
get_sync_setup_context
get_cloud_sync_status
sync_cloud_now
get_cloud_sync_runtime_status
list_cloud_devices
```

调用链固定为 `CloudAccountService -> CloudTokenBroker -> AuthManager -> CloudApiClient`。React 不传入 base URL、Token、issuer、subject、scope、账户 ID 或 Cloud request headers；command 没有参数。Rust 返回 `CloudAccountBootstrap`：

```text
account.id / account.status
evaluatedAt
subscription.planCode / status / currentPeriodEnd
features.connectionSync:
  phase
  permissions
  limits
  usage
  effectiveAt / expiresAt / phaseEndsAt / deletionEligibleAt
  entitlementVersion / policyVersion
sync:
  initialized / keyGeneration / activeDeviceCount / initializedAt
localSync:
  status: disabled | ready | secure_storage_unavailable | corrupted
  keyGeneration
```

`planCode`、subscription status 和 `phase` 是服务端展示/状态机字段，Desktop 不得据此自行授权。所有 Cloud 动作必须消费服务端返回的具体 `permissions` 和 `limits`，服务端仍会在每次业务请求中执行最终授权。Cloud 是 `evaluatedAt`、绝对期限、配额和用量的权威来源；IPC 投影可以在前端内存中用于显示，但不能作为离线授权副本。

`sync` 表示 Cloud 服务端同步域状态；`localSync` 表示当前设备对对应 Cloud Account 的本地 SyncKeyStore 状态。只有 Cloud `sync.initialized=true` 且 `localSync.status=ready` 时，Desktop 才能把本机显示为可进行端到端同步。`localSync` 由 Rust 每次读取当前 Keychain 得出，不参与 Cloud 权益授权，也不写入 Cloud projection cache；缓存回退时 Rust 仍会重新读取本地 Keychain。

以下内容禁止进入任何 Cloud IPC 参数、返回值、React Store、Toast、开发者工具日志或通用日志：Access/Refresh/ID Token、Authorization Header、JWT、issuer、subject、scope 原文、原始 Claim、Cloud 原始错误 body、数据库连接信息和 Provider 配置。当前 Rust/TypeScript 契约测试会扫描 Bootstrap JSON 和公开错误，确认不存在这些字段。

Cloud command 使用独立 `CloudPublicError { code, message, retryable, occurredAt }`：

```text
CLOUD_UNAUTHENTICATED
CLOUD_REAUTHENTICATION_REQUIRED
CLOUD_AUTH_TEMPORARILY_UNAVAILABLE
CLOUD_INSUFFICIENT_SCOPE
CLOUD_TEMPORARILY_UNAVAILABLE
CLOUD_PROTOCOL_ERROR
CLOUD_ACCOUNT_NOT_INITIALIZED
CLOUD_CONNECTION_SYNC_NOT_ENTITLED
CLOUD_CONNECTION_SYNC_RESTRICTED
CLOUD_SYNC_DEVICE_LIMIT_EXCEEDED
CLOUD_SYNC_ALREADY_INITIALIZED
CLOUD_SYNC_INITIALIZATION_MISMATCH
CLOUD_SYNC_DEVICE_NOT_AUTHORIZED
CLOUD_SYNC_SETUP_INVALID
CLOUD_SYNC_SETUP_EXPIRED
CLOUD_SECURE_STORAGE_UNAVAILABLE
CLOUD_RECOVERY_KEY_EXPORT_FAILED
CLOUD_CONNECTION_SYNC_CONFLICT
CLOUD_CONNECTION_SYNC_QUOTA_EXCEEDED
CLOUD_CONNECTION_SYNC_ASSET_TOO_LARGE
```

`CLOUD_INSUFFICIENT_SCOPE` 表示 Logto API Resource、Permission 或角色授予不符合部署契约，不能解释为 Free 套餐；Free 未获同步权益是成功响应中的 `connectionSync.phase=not_entitled`。401 映射为需要重新登录，403 映射为 scope 配置问题，429/503/其他 5xx 与网络超时映射为暂时不可用，超大、格式错误或不兼容响应映射为协议错误。错误只包含固定中文消息，不透传服务端 message 或 body。

`get_sync_setup_context` 和 `get_cloud_sync_status` 的实时请求失败时，Rust 可以返回最近一次完整成功刷新保存的脱敏展示缓存。返回结果必须带有：

```text
source: "cloud" | "cache"
cachedAt: string | null
```

`source=cache` 只用于让设置页面在离线或 Cloud 暂时不可达时继续展示最近看到的账户、订阅、权益和同步状态；它不是当前权限证明。缓存不参与任何业务授权、配额判断、设备状态转换或同步调度。所有注册设备、设备批准/拒绝/领取、资产读写、恢复、轮换、删除和撤销操作都必须重新请求 Cloud，并以当前响应为准。

账户状态联网刷新由 Desktop 的账户卡片、Cloud 设置页面、账号变化后的页面加载以及用户主动重试/操作完成后的刷新触发；没有账户状态定时轮询、后台常驻刷新或状态栏触发的请求。账户卡片使用强制刷新，Cloud 设置页面对最近 10 秒内已完成的共享刷新进行短时去重。同步运行由 Rust `CloudSyncScheduler` 独立响应 `startup`、`authentication`、`foreground`、`local_change`、`retry`、`manual` 和 `resume`，不由 React 或状态栏直接启动。每次真实同步前仍需从当前认证与 Cloud 响应重新完成权威校验。

`sync_cloud_now()` 是 Phase 9D/9E 的 Rust-only 手动同步入口，不接收账户 ID、Token、密文或密钥参数。它现在通过 Phase 9E 调度器执行，与后台任务共享 single-flight 锁；Rust 从当前 NIEEX Account、Keychain 和本地 SQLite 事实重算待同步 operation，按先上传/删除、后增量拉取的顺序协调，并返回脱敏计数：

```text
uploaded / deleted / pulled / conflicted / ignored / cursor
```

本地 CRUD 不依赖该 command 成功；Cloud 不可达时 operation 会保留为 `unknown` 或待发送状态，下一次协调继续使用同一个 operation ID。Phase 9E 已将同一协调器接入应用启动/认证恢复、窗口恢复前台和本地连接/文件夹 CRUD 后的有界 debounce，并按 5s、15s、60s、300s 上限进行暂时不可用重试。暂停本机同步、账户切换和退出登录会取消旧调度；不要求后台常驻或推送。

`get_cloud_sync_runtime_status` 返回最近一次 Rust 调度器的脱敏运行时投影；`cloud-sync-runtime-changed` 在状态改变时发送相同结构的事件。该投影不是 Cloud 权限缓存，不包含账户 ID、Token、密文或密钥：

```text
phase:
  disabled | idle | syncing | paused | offline | read_only
  | quota_exceeded | conflicted | device_revoked
  | recovery_required | unavailable
trigger: startup | authentication | foreground | local_change | retry | manual | resume | null
lastStartedAt / lastCompletedAt / lastSucceededAt / nextRetryAt
retryAttempt
pendingOperations / conflicts
lastResult: uploaded / deleted / pulled / conflicted / ignored / cursor | null
lastErrorCode: CloudErrorCode | null
```

该状态只用于展示和后续 Phase 10 UX；本地连接、同步加密和 Cloud 最终授权仍分别由本地 Keychain/Rust 和 Cloud API 权威判断。

### 新设备授权（Phase 8B）

`begin_device_authorization({ deviceName })` 是新设备侧创建待授权请求的唯一 Desktop IPC 入口。Rust 会在系统 Keychain 的独立 pending 项中生成并保存新设备的 X25519/Ed25519 私钥、request/device ID、pairing nonce、验证码和绑定摘要，然后使用新设备签名私钥生成 Device Proof 并调用 Cloud。

成功响应只返回以下界面所需投影：

```json
{
  "evaluatedAt": "2026-08-08T00:00:00.000Z",
  "requestId": "…",
  "deviceId": "…",
  "deviceName": "DESKTOP-01",
  "status": "pending",
  "verificationCode": "F7KM-82QP-V4ND",
  "codeVersion": 1,
  "createdAt": "…",
  "expiresAt": "…",
  "codeExpiresAt": "…",
  "resumed": false
}
```

`verificationCode` 仅用于当前设备授权界面的人机核对，不是加密密钥；React 可以短暂持有该显示值，但不得持有或记录私钥、AMK、Recovery Key、Device Proof 原文、Bearer Token 或验证码绑定哈希。相同账户存在 pending 请求时，Rust 会复用原请求和密钥材料，避免重复创建第二套设备身份；网络结果未知时不能删除 pending Keychain 项。

缓存可以跨重启保存，但只包含脱敏 Cloud 展示投影和缓存时间，不包含 `localSync`、Access/Refresh/ID Token、Authorization Header、JWT、issuer、subject、scope 原文、原始 Claim、AMK、Recovery Key、设备私钥、Device Proof、密文、连接凭据或 Cloud 原始错误 body。登录账户切换或退出后必须清理或隔离旧账户缓存，不能把上一个账户的展示投影显示给当前账户。

Cloud IPC 失败只影响对应 Cloud 动作。未登录、刷新失败、Cloud 离线、响应错误或 Debug 配置错误均不得阻止本地 SQLite、连接 Explorer、数据库 Engine、设置或 AI Runtime。若没有可用缓存，UI 显示脱敏的暂时不可用状态并提供重试；不能把缓存缺失解释为 Free、未初始化或设备撤销。UI 等待超时只结束局部加载指示并保留已有展示结果，不创建伪造的 Cloud 错误；真实 IPC 错误仍由 Rust 脱敏错误投影负责。依赖本次权威 Cloud 状态的辅助读取（例如待授权设备、路径补全和冲突列表）不得在缓存或 Cloud 刷新中的状态下提前发起。

### 旧设备批准与新设备领取（Phase 8C/8D）

旧设备通过以下窄 IPC 读取和处理待授权请求：

```text
list_pending_device_authorizations()
approve_device_authorization({ requestId, verificationCode })
reject_device_authorization({ requestId })
```

Rust 使用 committed `SyncKeyStore` 生成当前设备 Device Proof；批准时在 Rust 内根据待授权设备公钥、短码绑定摘要和本地 AMK 创建 HPKE 设备信封。前端只收到设备名称、状态、时间、公钥脱敏投影和操作结果，不接触 AMK、私钥、验证码绑定哈希或 Device Proof。

新设备通过：

```text
claim_device_authorization()
cancel_device_authorization({ requestId })
```

领取时 Rust 从 pending Keychain 读取新设备私钥，使用稳定的 request/action operation ID 调用 Cloud，解封并校验设备信封中的 AMK 后写入 committed `SyncKeyStore`。只有 committed Keychain 写入并校验成功后才删除 pending 项；网络结果未知或安全存储写入失败时必须保留 pending 材料，允许使用相同 operation ID 重试。取消成功后才清理新设备 pending 项。

### 本机暂停与永久撤销（Phase 8E）

```text
set_local_sync_paused({ cloudAccountId, paused })
revoke_local_sync_device()
```

`set_local_sync_paused` 只修改账户隔离的本地调度标记，不请求 Cloud、不删除 SyncKeyStore，也不改变 Cloud 设备的 `active` 状态；恢复时继续使用原设备身份。`revoke_local_sync_device` 则是 Cloud 权威安全操作：Rust 使用当前设备 Device Proof 和稳定 operation ID 调用永久撤销接口，收到成功响应后才删除 committed SyncKeyStore。网络结果未知或本地 Keychain 清理失败时不得把设备伪装成已完成，必须保留必要材料以便同一 operation ID 重试。

Recovery Key 恢复通过 `recover_cloud_device_with_recovery_key({ recoveryKey, deviceName })` 完成。Recovery Key、解出的 AMK 和 Recovery Auth 私钥全部只在 Rust 内短暂存在；Rust 从 Cloud 读取不透明恢复信封，本地解密后生成新设备密钥、包装设备信封并签署恢复登记请求。Cloud 成功登记设备后，Rust 才提交 committed `SyncKeyStore`；失败或结果未知时保留 pending 材料以便安全重试。该流程不需要旧设备在线，也不会把 Recovery Key 传入 Cloud 或 React。

## 2. 后端错误契约

Engine command 返回 `IpcResult<T>`，错误类型定义在 `src-tauri/src/error.rs`：

```rust
#[derive(Serialize, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    AuthFailed,
    NetworkTimeout,
    OperationTimeout,
    OperationOutcomeUnknown,
    QuerySyntaxError,
    ResourceNotFound,
    ValidationFailed,
    ResourceConflict,
    FeatureUnavailable,
    PermissionDenied,
    SystemInternal,
    OperationCanceled,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeErrorImpact {
    BusinessOnly,
    Retryable,
    Terminal,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub runtime_impact: RuntimeErrorImpact,
    pub message: String,
    pub details: Option<String>,
}

pub type IpcResult<T> = Result<T, IpcError>;
```

前端类型位于 `src/types/ipc/errors.ts`，必须与 Rust 枚举保持同步。`runtimeImpact` 是业务失败对所属数据库运行时会话的显式影响，不得由前端根据 `code` 或 driver name 猜测：

- `businessOnly`：语法、校验、对象不存在、冲突和单个业务操作超时等，不改变 runtime health；
- `retryable`：network/TLS/HTTP/SSH transport 或 health probe 暂时失败，可进入有限恢复；
- `terminal`：认证/凭据失效等，不应自动重试，runtime 进入 error。

`OPERATION_OUTCOME_UNKNOWN + retryable` 表示 mutation 已经发送或收到成功响应，但后端无法从远端事实确认最终结果。它不等价于“未执行”，也不等价于 profile 已断开；通用 runtime health 可以按 retryable 语义进入 degraded/recovery，但业务 surface 必须保留待确认状态。ClickHouse create UI 会保留 dirty draft、保持 create mode、不 retarget、不伪造 baseline；edit UI 会保留原 snapshot 与 dirty draft，并在可读时保存真实 remote schema 供冲突处理。两者都必须让旧 preview 失效并重新 preview 后才允许再次执行。

`FEATURE_UNAVAILABLE + businessOnly` 表示当前服务器版本、edition、数据库 engine、scope 或尚未发布的产品能力明确不支持该操作；`PERMISSION_DENIED + businessOnly` 表示当前账号无法观察或执行该能力。两者都不损伤 runtime health。能力探测中，前者可形成 `unsupported`，后者必须形成 `unknown`，不能把权限不足伪装成“服务器不支持”。ClickHouse 基础版对 `ON CLUSTER` 使用 `FEATURE_UNAVAILABLE` 在网络发送前拒绝，因为产品发布位固定为 `clusterDdl.executable=false`。

`OPERATION_CANCELED + businessOnly` 也用于数据库运行时会话的生命周期竞争：当 profile/tab 的旧建连 attempt 被显式断开或更新一轮建连取代时，后端会终止 driver construction 或关闭迟到 driver，并返回该错误。它表示旧操作已失效，不表示当前 runtime health 恶化，前端也不得弹出默认错误 toast。

Rust 后端会通过 `tauri-plugin-log` 记录 Engine IPC 诊断日志。日志记录发生在 `ConnectionRuntimeManager` 的驱动调用边界，以及少量驱动低层失败边界（例如 Oracle DML / SQL 执行失败）。日志字段包含 operation、driver、profileId、可选 tabId、可选 container 摘要、错误码、message 和 details。该机制不改变 `IpcError` JSON shape，也不要求前端额外处理。

## 3. 前端统一入口

`apiInvoke<T>()` 是 Engine IPC 的唯一入口：

```ts
export async function apiInvoke<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: ApiInvokeOptions,
): Promise<T>;
```

行为约定：

- `Ok(T)` 直接返回数据。
- `Err(IpcError)` 或其他 Tauri rejection 会通过 `normalizeIpcError()` 归一化。
- 调用方 catch 到的错误始终按 `IAppError` 处理。
- 缺少 `runtimeImpact` 的旧后端/非结构化 rejection 兼容为 `businessOnly`，不会通过错误码猜测健康。
- 默认情况下，只有同时带 `profileId` 且 `runtimeImpact=retryable|terminal` 的失败会发布 runtime failure event；`trackRuntimeHealth: false` 可显式关闭该行为。
- 默认弹出 `toast.error`；传入 `{ silent: true }` 时由调用方自行展示。
- `OPERATION_CANCELED` 默认不弹 toast。
- DEV 环境打印 command、code、message、details，便于排查。
- Rust 后端同时写入 Tauri log；排查 engine 问题时以前端 command 日志定位 IPC，再用后端 `operation/profileId/tabId/container` 日志定位具体驱动失败点。

本地 storage CRUD 不使用 `apiInvoke()`；它们仍由 storage wrapper 自己处理。

## 4. 错误基础设施

`src/lib/ipc-error.ts` 集中提供纯函数：

```ts
isIAppError(value: unknown): value is IAppError
normalizeIpcError(raw: unknown): IAppError
formatIpcError(error: unknown): string
getIpcErrorToastMessage(error: IAppError): string
shouldRetryIpcError(failureCount: number, error: unknown): boolean
```

使用分工：

- `apiInvoke()` 使用 `normalizeIpcError()` 和 `getIpcErrorToastMessage()`。
- Query hook 使用 `shouldRetryIpcError()`。
- 页面 inline error 使用 `formatIpcError()`。
- 表单或业务分支可以用 `isIAppError()` / `error.code` 做精细处理。

## 5. Retry 策略

Engine IPC 的默认 query retry 策略按显式 runtime impact 处理，而不是按错误码推断：

- `runtimeImpact=retryable`：最多重试 3 次；
- `runtimeImpact=businessOnly`：不重试；
- `runtimeImpact=terminal`：不重试。

因此 `NETWORK_TIMEOUT` 既可以是 transport/health failure（`retryable`），也可以是被操作级 timeout 约束的单次业务请求（`businessOnly`）；`shouldRetryIpcError()` 只读取 `runtimeImpact`。`AUTH_FAILED`、语法/校验/资源/冲突、`SYSTEM_INTERNAL` 与 `OPERATION_CANCELED` 当前均不会进入默认 query retry。

全局 `QueryClient` 仍保持 `retry: false`；需要 Engine IPC retry 的 hook 显式使用 `shouldRetryIpcError()`。

## 5.1 Engine 元数据容器契约

`list_containers` 返回统一 `DataContainer[]`。`DataContainer.container` / `ContainerRef` 是唯一权威寻址信息；展示字段不能参与后续 IPC 寻址。

```ts
interface ContainerProperty {
    key: string;
    label: string;
    value: string;
}

interface DataContainer {
    id: string;
    name: string;
    kind: ContainerKind;
    isLeaf: boolean;
    container: ContainerRef;
    typeName?: string | null;
    nullable?: boolean | null;
    itemCount?: number | null;
    properties?: ContainerProperty[];
}
```

`itemCount` 是可选的展示型统计元数据，表示容器内业务条目的总量，不保证等于 Explorer 当前已加载的直接子节点数量。当前实现只由 Redis `redis_database` 填充，语义为该逻辑库内 key 总数；Redis `redis_key_prefix` 的前缀级 key 数量继续由 `browse_key_tree` 在内容区展示，避免 Explorer 前缀展开触发完整前缀扫描。后续关系型 asset group、文档集合、搜索索引或向量集合可复用该字段，但必须在对应架构文档中说明统计口径和性能边界。

`properties` 是可选的通用只读属性列表。`key` 是 driver 内稳定机器键，`label/value` 是安全展示文本；该列表不得包含 credential、含凭据 URL、raw HTTP response 或未截断的敏感内容，也不得参与 `DataContainer.id`、`ContainerRef`、capability、菜单资格、destructive action、mutation 或 runtime health。空列表由 Rust 省略序列化，TypeScript 因此保持 optional。

## 5.2 连接高级选项与测试契约

网络型连接 payload（当前 PostgreSQL、MySQL、Redis、Oracle、ClickHouse）可携带通用高级字段：

```ts
interface SshTunnelConfig {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    authMethod: "password" | "private-key";
    password?: string;
    privateKeyPath?: string;
    privateKeyPassphrase?: string;
    hostVerification?: "trust-on-first-use" | "skip";
    hostKeyFingerprint?: string | null;
}

interface NetworkConfig {
    host: string;
    port: number;
    username?: string;
    password: string;
    savePassword: boolean;
    connectTimeoutSeconds?: number;
    sshTunnel?: SshTunnelConfig;
}

interface OraclePayload extends NetworkConfig {
    driver: "oracle";
    serviceName?: string;
    sid?: string;
    connectDescriptor?: string;
    role?: "normal" | "sysdba" | "sysoper";
}

interface ClickHousePayload extends NetworkConfig {
    driver: "clickhouse";
    defaultDatabase?: string;
    protocol: "http" | "https";
}
```

ClickHouse 默认 `http://localhost:8123`、username `default`、database `default`、connect timeout 5 秒。Rust profile 对未知 protocol 保留为 unsupported 并在创建 client 前返回 `VALIDATION_FAILED`，不会把 payload 解析失败包装成连接成功。

SQLite local-file payload uses a separate non-network model:

```ts
interface SqlitePayload {
    driver: "sqlite";
    dbFilePath: string;
    isReadOnly?: boolean;
}
```

`test_connection_config` for SQLite accepts `driver="sqlite"` and the payload above. It opens the existing local file through the engine runtime, returns the file path as `endpoint`, returns `driverName="sqlite"`, and may return `serverVersion` from `sqlite_version()`. SQLite does not use SSH host key fingerprinting and does not accept host, port, user, password, SSL/TLS, SSH, cloud, or remote file fields.

SQLite Phase 5 returns `schemaBrowser=true`, `dataTableBrowser=true`, `sqlExecutor=true`, `tableRowMutator=true`, `tableRowInserter=true`, and `transactionManager=true`, while `schemaMutator=false`. It uses existing Engine IPC commands only: `list_containers`, `describe_table`, `browse_table_data`, `get_table_page_stats`, `preview_table_change_set`, `commit_table_change_set`, `update_table_row`, `delete_table_rows`, `execute_sql`, `begin_tab_transaction`, `commit_tab_transaction`, `rollback_tab_transaction`, and `get_tab_transaction_state`. Writable resource state is still returned per `QueryResult`: only writable-profile ordinary tables with an explicit non-binary primary key set `sourceWritable=true` and `sourceInsertable=true`; read-only profiles, views, no-primary-key tables, and binary-primary-key tables remain read-only and cannot begin a transaction. SQLite begins with `BEGIN IMMEDIATE`, pins the tab connection for transactional DataTable browse/page stats/DML, keeps a failed save active for explicit rollback, and rolls back an open transaction when the tab runtime closes. SQLite does not add driver-specific IPC or SQL Editor transaction controls.

驱动专属 TLS 字段：

- PostgreSQL `sslMode?: "disable" | "require" | "verify-ca" | "verify-full"`。
- MySQL `sslMode?: "disable" | "require" | "verify-ca" | "verify-identity"`。
- Redis `useTLS?: boolean`。
- Oracle Phase 1 不暴露 SSL/TLS、wallet 或 TNS_ADMIN 字段；`connectDescriptor` 只接受 EZConnect 风格，完整 TNS `DESCRIPTION` descriptor 在后端返回 `VALIDATION_FAILED`。

`test_connection_config` 与保存后的 `connect_profile` 使用同一套 profile 解析、SSH endpoint 解析、TLS mode 映射和 timeout 行为。测试返回：

```ts
interface ConnectionTestResult {
    latencyMs: number;
    driverName: string;
    endpoint: string;
    serverVersion?: string | null;
    sshHostKeyFingerprint?: string | null;
}
```

当 SSH 启用时，`endpoint` 以 `原始数据库 endpoint via SSH sshHost:sshPort` 展示路由。`sshHostKeyFingerprint` 只在 SSH 握手捕获到 host key 时返回；前端可将其回填到当前连接表单，最终仍由用户保存连接时写入本地存储。`connect_profile` 不会在运行时自动修改本地连接记录。

ClickHouse 的 `test_connection_config`、`connect_profile` 和 `open_tab_runtime` 都通过同一个官方 HTTP client 构造路径并执行有界真实探测。当前 runtime 返回 `schemaBrowser=true`、`dataTableBrowser=true`、`tableRowMutator=true`、`tableRowInserter=true`、`sqlExecutor=true`，声明 direct managed SQL execution，并通过 `schemaMutation` 精确声明七类 schema object；`schemaMutator=false`、`transactionManager=false`。native schema mutation、SQL Editor direct access 和 DataTable write 是相互独立的授权边界，具体表是否可写仍以 `QueryResult` 为准。

具体结构写入授权以可选 `DriverCapabilities.schemaMutation` 为唯一权威来源。它按 `ContainerKind` 声明 `create/alter/drop/clear/materialize` 操作，并同时描述 driver 级 `ddlPreview`、`destructiveConfirmation`、`remoteDriftProtection` 保护设施。迁移期 `schemaMutator` 只保留关系型 `SchemaMutator` trait 的兼容布尔值；前端不得再从该布尔值推导某个具体操作。当前 MySQL/PostgreSQL 声明 database/table 的 create/alter/drop，Oracle 只声明 table 的 create/alter/drop；ClickHouse Phase 5C 保持 `schemaMutator=false` 与 `as_schema_mutator()=None`，同时通过 native extension 精确声明 database create/drop、table create/alter/drop、column clear/materialize，并把三项保护设施全部设为 true。

ClickHouse `list_containers` 允许根级同时返回 databases 与 `groupType=functions,database=null` 的 asset group；function 使用 connection-scoped `objectName`。database 下返回 tables/views/materialized_views/dictionaries，table 下返回 columns/indexes/projections/partitions，View/MV 只返回 columns。权限拒绝返回 `SYSTEM_INTERNAL + runtimeImpact=businessOnly`，不得伪装为空数组；network timeout 仍为 `retryable`，authentication failure 仍为 `terminal`。

ClickHouse direct HTTPS 保留原始 hostname，由 rustls 和系统原生根证书执行正常 SNI/hostname 验证；不提供 skip verification。HTTP + SSH 使用 resolved loopback endpoint 并由 driver 持有 tunnel。HTTPS + SSH 在当前 tunnel 无法保留原始 ClickHouse hostname 的情况下，于 endpoint resolution 前返回 `VALIDATION_FAILED`。

后端必须重复关键校验：SSH 必填项、认证材料、已保存 fingerprint 匹配、PostgreSQL `verify-full` + SSH、MySQL `verify-identity` + SSH、ClickHouse HTTPS + SSH、ClickHouse host/port/protocol/timeout。前端校验只用于更快反馈，不是安全边界。

Oracle 当前后端 capabilities 为 `schemaBrowser=true`、`schemaMutator=true`、`dataTableBrowser=true`、`sqlExecutor=true`、`tableRowMutator=true`、`tableRowInserter=true`、`transactionManager=true`，并保持 `keyValueBrowser=false`、`graphQueryer=false`、`vectorSearcher=false`。Oracle `role` 目前只接受 `"normal"`；`"sysdba"` / `"sysoper"` 会返回 `VALIDATION_FAILED`。

Oracle Phase 1.5 不新增 IPC，也不改变 `DataContainer` / `ContainerRef` JSON shape。变化仅限 `list_containers(parent=null)` 的 Oracle 返回层级：连接根直接返回 `kind="schema"` 的 schema/user containers，而不是先返回一个 service/SID `kind="database"` wrapper。schema 及以下节点仍必须携带 `container.database`，其值为当前 service / SID / EZConnect alias，用于 SQL context、保存查询匹配和后端对象寻址。

Oracle Phase 2 启用普通表 DataTable insert/update/delete 与 tab runtime 事务，不新增 IPC 命令。`QueryResult` 包含 `sourceInsertable`；前端新增行入口必须同时满足 `capabilities.tableRowInserter=true`、`queryResult.sourceInsertable=true` 且容器为真实表。Oracle 对无主键表、view、materialized view 返回 `sourceInsertable=false`，并只对普通表、完整主键定位的 change set 开放写入。Oracle Phase 2 不启用 `ROWID` 编辑，不支持 view/materialized view 编辑。

Oracle Phase 3 复用既有 Table Designer IPC，不新增 Oracle 专用命令。Oracle 普通表支持 `describe_table`、`preview_create_table`、`create_table`、`preview_update_table` 和 `update_table`；database/PDB/user/tablespace 级结构管理仍返回不支持错误。Oracle Table Designer 要求 `ContainerRef.schema` / owner 上下文，前端应从 schema 或 schema 下 Tables 节点进入新建表。

## 5.3 SQL 编辑器 legacy 与 managed 契约

SQL 查询编辑器行为见 [sql-editor.md](../../development/sql-editor.md)。没有声明 managed lifecycle 的驱动继续使用 `execute_sql` Engine IPC：

```ts
interface SqlExecutionContext {
    database?: string | null;
    schema?: string | null;
}

const result = await apiInvoke<QueryResult>(
    "execute_sql",
    {
        profileId,
        tabId,
        context: { database, schema },
        sql,
        page,
        pageSize,
    },
    { silent: true },
);
```

约束：

- SQL 编辑器调用必须传 `tabId`，后端必须命中对应 tab runtime，不应静默回退到 shared runtime。
- `context` 是结构化执行上下文。前端不得将 `USE`、`SET search_path` 等隐藏语句拼到用户 SQL 前面。
- MySQL 只接受 database 上下文；Schema selector 不显示。
- PostgreSQL 接受 database + schema 上下文；缺省 schema 走连接默认 schema 或 `public`。
- Oracle 接受 schema 上下文；后端通过 `ALTER SESSION SET CURRENT_SCHEMA` 在本次 pooled connection 上切换，并在返回连接前重置 session state。
- SQLite 接受文件 database 上下文并拒绝 schema；SQL Editor tab runtime 与 DataTable pinned transaction 保持隔离。
- ClickHouse 接受 database-only context 并拒绝 schema；后端使用 request client 的 database context，不前置 `USE` 或改写 SQL。
- 一阶段只支持单个可执行 SQL 语句。多语句请求返回 `VALIDATION_FAILED`。
- 空 SQL 在前端拦截，不发起 IPC。
- 自由 SQL 结果在 SQL editor 中只读，不复用 DataTable 的行变更或事务按钮。
- legacy `execute_sql` 不提供服务端确认取消；声明 managed lifecycle 的驱动使用下述 start/snapshot/cancel/release 契约。

`QueryResult.rows` 使用 JSON 值列表；超出 JavaScript 安全整数边界的整数与 Decimal 以字符串返回。Driver 必须先区分数据库真实 `NULL` 与非空值解码失败：真实 `NULL` 投影为 JSON `null`，非空值无法按声明类型解码时返回结构化 `IpcError`，不得静默伪装成 `null`。MySQL 的公共结果 codec 同时服务 DataTable、SQL Editor 与 AI Tool shared runtime；`FLOAT` / `DOUBLE` 分别按 `f32` / `f64` 解码，Decimal 保留精确十进制文本，JSON 与日期时间使用稳定文本，动态 SQL 列元数据按 MySQL type name 分类。`QueryResult.rowLocatorStrategy` 为 `primaryKey | rowSnapshot | null`。`TableRowLocator` 使用 tagged union：`{ kind: "primaryKey", parts }` 或 `{ kind: "rowSnapshot", parts, expectedMatches }`；不得把 ClickHouse sorting/primary key 填入 `primaryKey` variant。自由 SQL固定只读；ClickHouse DataTable 只有普通 Local `MergeTree/ReplacingMergeTree` 和已支持标量列返回 snapshot 写入能力，复杂列与 View/MV 只读。

`TableChangeSetUpdate` 使用 `locator + changes`，`deletes` 是 locator 数组。`TableChangeSetCommitResult.outcome` 为 `applied/submitted/outcomeUnknown/conflict`。关系型驱动成功提交返回 `applied`；ClickHouse Update/Delete 必须先证明每个 snapshot 恰好匹配一行，执行前复核，使用 `mutations_sync=1`，再进行事实核验。transport/timeout、执行后无法确认或批次中可能部分完成时返回 `outcomeUnknown`，前端不得清空 change set 或自动重试。过期或多匹配快照返回 `RESOURCE_CONFLICT + businessOnly`。

`TablePageStats.totalRows/totalPages` 是 JSON-safe integer：不超过 JavaScript 安全整数时为 number，超过时为十进制 string。TypeScript 对应 `JsonSafeInteger = number | string`，不得先转成 `Number` 再比较或格式化。

ClickHouse Phase 3 动态结果使用官方 client `fetch_bytes("JSONCompactEachRowWithNamesAndTypes")`。DataTable 在服务端生成 `LIMIT pageSize+1 OFFSET checkedOffset`；free SQL 保留原文，以客户端流式窗口跳过前页并保留 `pageSize+1`，最大 skip 100,000。每个 free-SQL 请求强制 `readonly=2`，拒绝该 setting 时 fail closed；本地只拒绝空/多语句、顶层 `FORMAT` 和顶层 `INTO OUTFILE`。response/row/cell/depth/node/window/30 秒超限返回结构化 business error，不静默截断或无 readonly 重试。

### 5.3.1 Managed SQL execution 与 Raw artifact

`DriverCapabilities.sqlExecution.managedLifecycle=true` 时，前端改用以下 camelCase Engine IPC：

```ts
start_sql_execution({ profileId, tabId, request, onEvent })
    -> SqlExecutionHandle
get_sql_execution_snapshot({ profileId, tabId, executionId })
    -> SqlExecutionSnapshot
cancel_sql_execution({ profileId, tabId, executionId })
    -> SqlExecutionSnapshot
release_sql_execution({ profileId, tabId, executionId })
    -> void
save_sql_execution_artifact({
    profileId,
    tabId,
    executionId,
    artifactId,
    destinationPath,
}) -> void
```

`start_sql_execution` 的 `request` 包含结构化 `context`、单条原始 `sql` 与 `{ resultMode, timeoutMs, page, pageSize }`。`onEvent` 是 per-execution Tauri Channel，只提供低延迟 snapshot 通知；`get_sql_execution_snapshot` 是 authoritative source。每个 tab 同时只允许一个 active execution，后端生成 execution ID 和独立 query ID，所有 u64 metrics 与 Raw `byteLength` 都按 JSON-safe integer 序列化。

Manager 在生成 ID、调用 classifier 和注册 coordinator 前验证 `managedLifecycle`、request 边界和 Raw capability。`resultMode=raw` 要求 `rawResult=true` 且 `page=1`；未声明能力时返回 `VALIDATION_FAILED`，不会调用 driver 或创建 artifact。默认 Run、分页与脚本使用 Grid，Raw 只允许前端显式发起的单 statement execution。

Raw 成功 outcome 的 IPC shape 为：

```ts
interface RawSqlExecutionOutcome {
    kind: "raw";
    format?: string | null;
    mediaType: string;
    byteLength: number | string;
    preview: string;
    previewTruncated: boolean;
    artifactId: string;
}
```

`artifactId` 是 opaque ownership token，不是 temp path。Manager-owned store 同时校验 profile/tab/execution/artifact；`save_sql_execution_artifact` 只接受当前 terminal Raw outcome 的 matching ID，并在 blocking worker 中用 destination sibling temp + atomic persist 另存。destination 必须是 parent 已存在的绝对文件路径，不能位于内部 artifact root。失败保留 source 以便重试，IPC error 与日志不得包含 source path、destination path、Raw bytes、preview 或完整 SQL。

生产 artifact 限制为 512 MiB；文本 preview buffer 为 1 MiB，二进制 hex preview buffer 为 4 KiB。新 execution、显式 release、tab close、profile disconnect 和 app teardown 释放对应 source；取消、timeout、transport error、上限错误和迟到 completion 删除 partial。ClickHouse `DirectRaw` 使用 `fetch_bytes("TabSeparatedRaw")` 作为默认格式而不改写 SQL，显式顶层 `FORMAT` 优先；zero-byte `INTO OUTFILE` 返回中性 command outcome，不创建本地 artifact。

保存查询 CRUD 属于本地 Storage IPC，不属于 Engine IPC。命令为 `list_saved_queries`、`get_saved_query`、`create_saved_query`、`update_saved_query`、`delete_saved_query`，像连接 CRUD 一样走直接 `invoke` 封装。保存查询随连接删除级联删除。

## 5.4 匿名安装标识 IPC

Tauri 启动阶段由 Rust 端确保 app data 目录存在匿名安装标识 store：`nexus_pilot_installation.json`。该标识用于区分本地安装环境，不代表用户账号，不作为认证凭据，也不从硬件、用户名、路径、MAC 地址等设备指纹派生。

只读命令：

```ts
interface InstallationIdentity {
    schemaVersion: 1;
    installationId: string;
    createdAt: string;
    createdByVersion: string;
}

const identity = await invoke<InstallationIdentity>("get_installation_identity");
```

约束：

- `installationId` 为 Rust 端生成的 UUID v4。
- 已存在且格式合法的 `installationId` 必须在应用更新后继续复用。
- `createdAt` 为首次生成或修复缺失元数据时写入的 UTC ISO 时间。
- `createdByVersion` 为首次生成或修复缺失元数据时的应用版本；后续应用更新不得重写该字段。
- 如果 store 缺失、`installationId` 缺失或格式非法，Rust 会生成新的安装标识并立即保存。
- 当前前端不在启动流程中读取该命令；若未来需要在请求中附带安装标识，应通过 `src/lib/tauri/installation.ts` 的只读封装调用。

## 6. Schema IPC

表设计器读取现有表结构使用只读 Engine IPC：

```ts
const schema = await apiInvoke<TableSchema>(
    "describe_table",
    { profileId, container },
    { silent: true },
);
```

约束：

- `container.kind` 必须是 `table`，视图和 asset group 不进入本命令。
- 当前阶段 MySQL / PostgreSQL / Oracle 普通表支持；Redis 和未来未实现驱动返回“不支持”错误。
- 本命令只读取 schema，不生成 DDL、不创建表、不修改表结构。
- 前端应通过 `useTableSchema()` 与 `queryKeys.tableDesign(...)` 调用，并在 inline error 中使用 `formatIpcError()`。

### 6.1 Native Schema Describe 扩展

关系型 `TableSchema` / `SchemaMutator` 保持原契约。需要数据库原生结构语义时，driver 可通过 `DatabaseDriver::as_native_schema_extension()` 暴露通用 `NativeSchemaExtension`；Manager 使用 tagged `NativeSchemaDescribeRequest` / `NativeSchemaDocument` 分发，命令层再返回具体强类型，不把任意 `serde_json::Value` 暴露为 IPC contract。

ClickHouse Phase 5A 提供只读命令：

```ts
const schema = await apiInvoke<ClickHouseTableSchema>(
    "describe_clickhouse_table_schema",
    { profileId, container },
    { silent: true },
);
```

约束：

- `container` 必须是带非空 `database` 与 `table` 的普通 table 地址，且不能携带 relation schema context；
- 返回值是 `ClickHouseTableSchema` 强类型，覆盖 identity、engine/arguments、ordered columns、default/materialized/alias/ephemeral、codec、column/table TTL、keys、explicit settings、projections、data-skipping indexes、editability 和 baseline；
- Describe 组合 `system.tables`、`system.columns`、可用的 projections/index catalogs 与 canonical CREATE。ClickHouse 26.5 的 `system.data_skipping_indices.type` 只返回 family，因此 Index Describe 优先读取 `type_full`；旧 catalog 缺少该列时回退 `type`，仍不能恢复完整参数则保留原始事实并生成 blocker。catalog 缺失但 canonical 可无损证明的列 TTL 可以回填；来源冲突、未知 clause/modifier、未知 engine/default kind 或不完整对象定义必须生成 blocker，不能静默丢失；
- `editability.mode` 为 `editable/restricted/readonly`。它描述当前文档的无损程度，不授予写入能力；Phase 5A UI 即使收到 `editable` 也固定只读；
- `baseline.revisionHash` 是 canonical schema 的稳定 lowercase SHA-256，用于缓存与快速对比。它不是未来执行写入时的唯一信任依据；后端仍须重新 Describe 远端事实；
- Describe 契约本身不授予写入能力；Phase 5D edit mode 还必须按动作命中 table/alter、column/clear|materialize、projection/create|drop|clear|materialize 或 index/create|drop|clear|materialize 的精确 capability，且相关定义可无损证明。restricted/readonly 文档继续无损只读。

### 6.2 Native Schema Create 扩展

`NativeSchemaExtension` 还提供 tagged `NativeSchemaCreateTarget`、`NativeSchemaExecuteCreateRequest`、`NativeSchemaMutationPreview` 与 `NativeSchemaCreateResult`。ClickHouse 使用四个强类型 Engine IPC：

```text
preview_create_clickhouse_database
create_clickhouse_database
preview_create_clickhouse_table
create_clickhouse_table
```

约束：

- Database target 只包含名称；Table target 包含 database/name、ordered columns、engine/arguments、keys、column/table TTL、codec、comments 与 explicit settings。projection、data-skipping index、Replicated/Shared/Distributed/Keeper engine、`ON CLUSTER`、`AS SELECT`、`ATTACH`、`CLONE`、`TEMPORARY` 和显式 UUID 不进入 Phase 5B target。
- preview 从强类型 target 执行 fail-closed allowlist 校验并生成确定性单 statement DDL，返回 statements/warnings/destructive/longRunning 与 domain-separated lowercase SHA-256 `planHash`。Phase 5B preview 固定 `destructive=false`、`longRunning=false`，且不生成 `IF NOT EXISTS`。
- execute 必须携带同一 target 与 `expectedPlanHash`。后端重新校验、重新规划并比较 hash；stale/伪造 hash 在网络调用前返回 `RESOURCE_CONFLICT`。
- 每条 DDL 只提交一次，使用独立 query id、`wait_end_of_query=1`、driver timeout 与 shutdown gate，不做自动重试。ClickHouse server code 57/82 映射为 `RESOURCE_CONFLICT`，错误与日志不得包含 statement bytes、对象名、连接 payload、凭据或 raw server payload。
- server success、transport/timeout/shutdown 等路径都必须 post-verify。Database 从 `system.databases` 读取存在性；Table 重新执行 native Describe，并返回真实 `ClickHouseTableSchema`。只有远端目标存在且语义匹配才返回 applied result。
- 无法确认远端结果时返回 `OPERATION_OUTCOME_UNKNOWN + retryable`。前端保留 create target 与 dirty draft，不 retarget、不清空、不伪造 schema snapshot，并使旧 preview 失效；下一次执行必须先生成新 preview。
- MergeTree canonical Describe 可能自动包含 `index_granularity=8192`。语义 verifier 允许这一项作为唯一的目标外 canonical 默认；其他未知或值不匹配的 explicit setting 仍返回 outcome unknown/fail closed。
- Native create 契约继续保持不变。基础版总 capability 有七个精确对象项：database create/drop、table create/alter/drop、column clear/materialize、projection create/drop/clear/materialize、index create/drop/clear/materialize，以及 view/materialized_view create/alter/rename/drop，并开启三项保护设施；`schemaMutator=false` 只表示关系型 `SchemaMutator` 不可用，不会屏蔽已声明的 native 操作，ClickHouse `as_schema_mutator()` 仍返回 `None`。

### 6.3 Native Schema Change 扩展

`NativeSchemaExtension` 的 Phase 5C/5D change 通道使用强类型 tagged union，不接收任意 JSON 或前端 SQL：

```text
NativeSchemaChangeTarget:
  clickhouse_table_alter
  clickhouse_table_drop
  clickhouse_database_drop
  clickhouse_column_clear
  clickhouse_column_materialize
  clickhouse_projection_create
  clickhouse_projection_drop
  clickhouse_projection_materialize
  clickhouse_projection_clear
  clickhouse_skipping_index_create
  clickhouse_skipping_index_drop
  clickhouse_skipping_index_materialize
  clickhouse_skipping_index_clear

preview_alter_clickhouse_table / alter_clickhouse_table
preview_clickhouse_column_action / execute_clickhouse_column_action
preview_drop_clickhouse_table / drop_clickhouse_table
preview_drop_clickhouse_database / drop_clickhouse_database
preview_clickhouse_projection_change / execute_clickhouse_projection_change
preview_clickhouse_skipping_index_change / execute_clickhouse_skipping_index_change

NativeSchemaChangeResult:
  clickhouse_projection_change
  clickhouse_skipping_index_change
```

`ClickHouseAlterTableTarget` 包含完整 `baseline: ClickHouseTableSchema`、完整 `desired: ClickHouseCreateTableTarget` 和 `columnRenames: ClickHouseColumnRenameIntent[]`。rename intent 以 source identity 明确表达，后端禁止按 ordinal、相似度或 drop/add 组合猜测。Column action target 包含完整 table baseline 与 column name，只表达整列 CLEAR/MATERIALIZE，不接受自由 partition expression。Drop target 只包含受控 `ContainerRef`。

八个 Phase 5D 对象 target 同样携带完整 table baseline。Projection Create target 只增加 `name + query`；query 必须是一条顶层 `SELECT` body，允许 select list、`WHERE`、`GROUP BY`、`ORDER BY`，拒绝顶层 `FROM`、`JOIN`、`UNION`、`PREWHERE`、`LIMIT`、`OFFSET`、`INTO`、`FORMAT`、`SETTINGS`，并拒绝 comment、分号、第二 statement 与不平衡 quote/delimiter。无法按该 grammar 无损验证的已有 Projection 保留原始 query 并保持 readonly。

Skipping Index Create target 只允许 `minmax()`、`set(max_rows)`、`bloom_filter([false_positive])`、`ngrambf_v1(ngram_size, filter_bytes, hash_functions, random_seed)` 与 `tokenbf_v1(filter_bytes, hash_functions, random_seed)`。参数按精确 arity 和 numeric domain 校验；expression 必须是单个非空、quote-aware、delimiter-balanced、无分号表达式，`granularity` 必填且大于 0。未知 family、参数不完整或 catalog 信息不足时保留原始值并保持 readonly。

Projection/Index 不支持 rename 或 inline modify，修改定义必须执行各自带 fresh preview 的 Drop + Create。Materialize/Clear 只覆盖 whole-table object，不接收 partition expression，也不生成 `IN PARTITION`；所有对象 DDL 都不生成 `IF EXISTS` / `IF NOT EXISTS`。

`NativeSchemaChangePlan` 返回：

- exact `statements` 与 `operations: NativeSchemaOperationSummary[]`；
- `destructive`、`longRunning`、`expectedTargetRevision`；
- `baseline: clickhouse_table | clickhouse_database`；database baseline 包含 database identity 与排序后的 child object engine/UUID/canonical create query；
- domain-separated lowercase SHA-256 `planHash`。

`NativeSchemaExecuteChangeRequest` 必须携带同一 target、preview baseline、`expectedPlanHash` 与 `confirmDestructive`。Manager 先检查 exact object/operation、remote drift facility，并在 preview 得出 destructive 后检查 destructive confirmation facility；execute 会重复 preview/protection gate。driver 重新规划并比较 hash，再重新 Describe/读取 remote full baseline；只比较前端 revision hash 不足以通过 drift gate。任何 destructive plan 在 `confirmDestructive=false` 时都必须在首条网络发送前返回 `VALIDATION_FAILED`，远端 baseline 变化返回 `RESOURCE_CONFLICT + businessOnly`。

当前主表 ALTER allowlist 与顺序为 rename → add → modify/reorder → column comment → SAMPLE BY → table TTL → setting RESET/MODIFY → table comment → drop column。engine、ORDER BY、PARTITION BY、PRIMARY KEY 变化 fail closed；SAMPLE BY 是唯一可变 key；`ttl_only_drop_parts` 是唯一经真实服务验证可 ALTER 的 table setting。Projection 或 data-skipping index 存在时，主表 ALTER 与 column action 继续拒绝；Phase 5D 只开放独立对象 target，不建立跨对象原子 ALTER。TTL post-verifier 对 quote 外的 `INTERVAL n UNIT` 与 `toIntervalUnit(n)` 做语义规范化，并允许 table TTL 的默认尾部 `DELETE` 省略；`DELETE WHERE` 不等价，column TTL 也不会删除 action 文本。

执行规则：

- DDL 不自动重试；每条 statement 使用独立 query id、`wait_end_of_query=1`、driver timeout/shutdown gate，第一条失败后停止；
- `NativeSchemaStatementProgress` 返回 `appliedCount/failedStatementIndex/remainingCount/queryIds`；
- `NativeSchemaExecutionStatus` 精确为 `applied/submitted/partiallyApplied/outcomeUnknown`；
- Table ALTER 与 Projection/Index Create 只有 post-Describe 与 desired target/definition 语义匹配时为 applied；Table/Database/Object Drop 只有 absence 已证明时为 applied；
- Column/Projection/Index CLEAR/MATERIALIZE 是 destructive + long-running，服务端接受后返回 submitted，不宣称 `system.mutations` 已完成；
- Projection/Index Create 是 safe + non-long-running；Object Drop 是 destructive + long-running。ambiguous action 返回 `outcomeUnknown`，不因 schema definition 未变化而推断 Materialize/Clear 已完成；
- partial/unknown 不用 desired target 覆盖 baseline；post-Describe 成功时返回真实 schema，读取失败时 schema 为 null；
- Drop SQL 不带 `IF EXISTS`，避免把确认期间对象变化伪装为成功。

### 6.4 ClickHouse View/MV 与 Temporary Session 扩展

Phase 5E 在同一 `NativeSchemaExtension` 上增加 support、session document、View create/change 强类型。公开 tag 固定为：

```text
NativeSchemaSupportRequest/Document:
  clickhouse_view

NativeSchemaSessionListRequest:
  clickhouse_temporary_views

NativeSchemaSessionDocuments:
  clickhouse_views

NativeSchemaCreateTarget/Result:
  clickhouse_view

NativeSchemaChangeTarget:
  clickhouse_view_alter
  clickhouse_view_rename
  clickhouse_view_drop

NativeSchemaChangeBaseline:
  clickhouse_view
  clickhouse_cluster_view

NativeSchemaChangeResult:
  clickhouse_view_change
```

Engine IPC 为：

```text
get_clickhouse_view_runtime_support
describe_clickhouse_view_schema
preview_create_clickhouse_view
create_clickhouse_view
preview_change_clickhouse_view
execute_clickhouse_view_change
list_clickhouse_temporary_views
```

`ClickHouseViewFamily` 使用七个稳定 snake_case tag：`normal`、`parameterized`、`temporary`、`materialized`、`refreshable_materialized`、`window`、`live`。`ClickHouseViewSchema` 包含 identity、family、scope、column definition、query body、security、comment、family definition、server support、editability 与 baseline。前端只提交一条最终进入 SELECT 的 query body；第二 statement、顶层 DDL/DML、`FORMAT`、`INTO OUTFILE` 以及未闭合 quote/comment/delimiter 都在 renderer 之前拒绝。

`ClickHouseViewRuntimeSupport` 为每个 family 的 Describe/Create/Alter/Rename/Drop 返回 `supported/unsupported/unknown` 与可选 reason，并携带 `supportRevision`。权限不足是 `unknown/PERMISSION_DENIED`；服务端明确缺失才是 `unsupported/FEATURE_UNAVAILABLE`。preview 与 execute 都核对 support revision，旧版本、旧 database engine、旧 scope 或旧 topology 不能复用 preview。

基础版 capability 的正式 scope 是 Local 和 Temporary。Cluster contract 保留 `discoverable/executable/observable/driftVerifiable`，但 `executable` 固定为 false；即使服务器目录可发现 cluster，任何 `ON CLUSTER` preview/execute 都必须在首条 DDL 前返回 `FEATURE_UNAVAILABLE`。topology/full-node baseline、node outcome、partial/unknown、redaction 与 no-retry 目前只是 unit/contract 证据，不得写成真实多节点支持。

Temporary View 的逻辑 scope 为 `{ ownerTabRuntimeId, sessionState }`，地址不含 database。物理 ClickHouse HTTP `session_id` 只存在于 Rust tab runtime 私有状态，禁止进入 IPC、TypeScript、profile、日志或持久化。`list_clickhouse_temporary_views` 和 Temporary Describe/Create/Change 必须命中同 profile 的 owner tab runtime；dependent designer 自身没有后端 runtime。关闭 owner、断开 profile或 app teardown 会使 session 过期并清理 dependents，过期 session 不自动重建。

View/MV preview 在既有 statements/warnings/destructive/longRunning/planHash 基础上返回：

- `riskFlags`: `destructive/dataLoss/longRunning/backgroundWork/clusterNonAtomic/experimental/deprecated`；
- `requiredConfirmation`: `none/confirm/typeObjectName/typeObjectAndCluster`；
- Local/Temporary 使用完整 `clickhouse_view` baseline；Cluster contract 使用 full-node `clickhouse_cluster_view` baseline；
- Alter/Replace diff 按 `MODIFY QUERY -> MODIFY REFRESH -> MODIFY SQL SECURITY/DEFINER -> MODIFY COMMENT -> CREATE OR REPLACE` 的确定性优先级，Temporary edit 是显式 Drop + Create；Rename 始终单独执行。

execute 必须携带原 target、baseline、`expectedPlanHash` 与 typed confirmation。DDL 不自动重试，每条 statement 使用独立 query id，首错停止；Create/Alter/Rename/Drop 只有远端 post-Describe/absence proof 后才是 `applied`。schema result 与 `initialRefresh/populate/windowInitialization/distributedDdl` background work 分离；`partiallyApplied/outcomeUnknown/conflict` 不允许用 desired target 合成远端事实。

## 7. 表 Schema Mutation IPC

表设计器创建新表、修改已有表，以及 Explorer 删除普通表都使用 table 级 Engine IPC：

```ts
const preview = await apiInvoke<SchemaMutationPreview>(
    "preview_create_table",
    { profileId, input },
    { silent: true },
);

const result = await apiInvoke<CreateTableResult>(
    "create_table",
    { profileId, input },
);

const updatePreview = await apiInvoke<SchemaMutationPreview>(
    "preview_update_table",
    { profileId, input: updateInput },
    { silent: true },
);

const updateResult = await apiInvoke<UpdateTableResult>(
    "update_table",
    { profileId, input: updateInput },
);

const dropPreview = await apiInvoke<SchemaMutationPreview>(
    "preview_drop_table",
    { profileId, input: { container } },
    { silent: true },
);

const dropResult = await apiInvoke<DropTableResult>(
    "drop_table",
    { profileId, input: { container, confirmDestructive: true } },
);
```

约束：

- `preview_create_table` / `create_table` 使用 `CreateTableInput`；`preview_update_table` / `update_table` 使用 `UpdateTableInput`。
- `UpdateTableInput` 包含 `container`、`baseline`、`target`、可选 `columnRenames` 与可选 `confirmDestructive`。`columnRenames` 用于把已有列名变化显式表达为 rename，避免后端误判为 drop + add；`confirmDestructive` 默认为 `false`，只用于执行阶段确认破坏性变更。
- `preview_drop_table` / `drop_table` 使用 `DropTableInput`。`DropTableInput.container.kind` 必须是 `table`，`confirmDestructive` 默认为 `false`；执行 `drop_table` 时必须显式传入 `confirmDestructive: true`，否则后端返回 `VALIDATION_FAILED`。
- 所有 CREATE / ALTER SQL 必须由 Rust 后端生成；前端只传结构化 schema draft 映射结果，不拼接或执行 DDL。
- 所有 DROP TABLE SQL 必须由 Rust 后端根据 `ContainerRef` 生成；前端不得通过 `execute_sql` 或字符串拼接实现删除表。
- MySQL / PostgreSQL / Oracle 支持建表闭环、常用 ALTER TABLE 子集和普通表删除；Redis 和未来未实现驱动返回“不支持”错误。
- 具体入口必须先通过 `schemaMutation` 的 object/operation 声明；`schemaMutator` 不能作为具体操作的 fallback。ClickHouse 的 database/table/column/projection/index create/alter/drop/clear/materialize 进入 native commands，不进入关系型 `preview_create_table/create_table`、`preview_update_table/update_table` 或关系型 drop commands，也不通过 `as_schema_mutator()` fallback。
- `preview_create_table` 和 `create_table` 必须使用同一套后端 DDL 生成逻辑，保证预览与执行一致。
- `preview_update_table` 和 `update_table` 必须使用同一套后端 diff 与 DDL 生成逻辑，保证预览与执行一致。
- `preview_drop_table` 和 `drop_table` 必须使用同一套后端 DROP TABLE 生成逻辑，保证预览与执行一致。预览必须返回 `destructive: true` 和删除结构及数据的 warning。
- 删除表只覆盖普通表，不覆盖 view、materialized view、asset group 或 column；当前不提供 `CASCADE`，Oracle 默认不附加 `PURGE`。
- 专业表设计器前端可以通过结构化控件编辑常用列类型参数，但不改变当前 IPC shape；最终 mutation payload 继续发送 `TableColumnSchema.typeName` 作为 SQL 类型片段。无法识别或自定义的类型通过 Raw 类型模式保留原始 `typeName`。
- `defaultValue` 当前按 SQL 表达式片段处理，例如 `0`、`CURRENT_TIMESTAMP`、`'anonymous'`。
- `TableSchema` advanced 字段：
  - `TableColumnSchema.identity` 表达 identity / auto increment 选项；`isIdentity` 继续保留为兼容布尔标记。
  - `TableColumnSchema.generated` 表达 generated column 的表达式和 `virtual` / `stored` 存储模式。
  - `TableColumnSchema.charset` / `collation` 表达列级字符集与排序规则。
  - `TableConstraintSchema.foreignKey` 表达 FK 引用表、引用列、`onUpdate`、`onDelete`。
  - `TableConstraintSchema.enforced` 表达 CHECK / FK 等约束是否 enforced；不同方言会按支持度渲染。
  - `TableSchemaBasics.partition` 表达 create-time raw partition clause 或已有表只读分区描述。
- `SchemaMutationPreview` 返回 `statements`，并可返回 `warnings` 与 `destructive` 标记；当 `destructive: true` 时，前端需要确认后再调用 `update_table`。
- `update_table` 执行前必须重新读取当前远端 schema，并与 `baseline` 比较；如果用户打开设计器后远端表结构已变化，返回 `RESOURCE_CONFLICT`。
- 当前 edit 模式支持受控子集：表注释、表级 MySQL engine / charset / collation、可安全添加的列、删除已有列、已有列重命名、类型变更、默认值与可空性变更、列注释、列级 charset/collation、索引新增 / 删除 / 修改（按 drop + create 执行）、基础 primary key 变更、FK / CHECK 增删改（按 drop + add 修改）、PostgreSQL identity add/drop/set generation，以及 MySQL 结构化 generated column 回放。类型变更、删除列、主键变更、约束删除、generated/identity 高风险重写等可能属于 destructive preview，需要用户确认后才能执行。已有表分区变更始终返回 `VALIDATION_FAILED`，要求使用手写 DDL 管理分区迁移。
- Oracle table schema mutation 只覆盖普通表。Oracle create 支持常用列类型、identity、virtual generated column、PK/unique/CHECK/FK、普通/唯一索引、table/column comment 和 create-time raw partition clause。Oracle update 支持表/列 comment、添加列、重命名列、类型/default/nullability 变更、索引增删改、PK/CHECK/FK drop + add 和删除列；类型变更、删除列、主键变更、约束删除等会标记 destructive。Oracle 不适用字段（engine、charset、collation、列 charset/collation、索引 method/comment）非空时返回 `VALIDATION_FAILED`；Oracle FK `onUpdate`、未启用约束、existing-table partition migration、stored generated column 和既有 generated/identity 迁移也返回 `VALIDATION_FAILED`。
- 目标表已存在时返回 `RESOURCE_CONFLICT`。

## 8. 调用示例

```ts
const result = await apiInvoke<QueryResult>(
    "browse_table_data",
    { profileId, tabId, container, page, pageSize },
    { silent: true },
);
```

```ts
const query = useQuery<DataContainer[], IAppError>({
    queryKey: queryKeys.containers(profileId, parent),
    queryFn: () => apiInvoke("list_containers", { profileId, parent }, { silent: true }),
    retry: shouldRetryIpcError,
});
```

```tsx
if (query.isError) {
    return <p>加载失败：{formatIpcError(query.error)}</p>;
}
```
