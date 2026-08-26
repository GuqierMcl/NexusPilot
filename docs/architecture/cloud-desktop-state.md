# Cloud Desktop 状态投影

本文定义 NexusPilot Desktop 内部的 Cloud 状态来源、Rust/Tauri/React 边界和可扩展能力投影。它只描述 Desktop 如何消费 Cloud 状态，不替代 [Cloud V1 client contract](../contracts/cloud-v1-client-api.md) 或 Cloud 服务端的授权器。

## 1. 单一状态来源

Cloud 的业务状态由 Rust 持有。React 不维护第二套 Cloud 业务状态机，也不根据套餐名称、缓存字段或自己的本地判断放行 Cloud 操作。

Rust 的 `CloudDesktopStateStore` 输出一个脱敏的 `CloudDesktopStateProjection`，其中包含五个相互独立但由同一个 Rust 状态源维护的维度：

```text
CloudDesktopStateProjection
├── connection       Cloud 状态读取连接阶段
├── context          账户、订阅、权益、Cloud 同步和本地密钥投影
├── capabilities     可扩展 Cloud 能力列表
├── runtime          本机同步运行时投影
└── refresh          最近一次刷新生命周期
```

`connection` 不替代 `runtime`：

- `connection = cached` 表示当前只能展示最近一次成功读取的缓存；
- `connection = permission_denied` 表示当前登录身份没有 Cloud 应用访问权限，不等同于登录会话失效；
- `runtime.phase = offline` 表示本机同步任务当前无法完成网络同步；
- 两者同时出现是合法状态，不应压平成一个会产生组合爆炸的枚举。

Cloud 账户登录生命周期仍然由 NIEEX Account 的 Rust `AuthManager` 管理；Cloud Desktop 状态在认证事件发生时同步清空或进入重新认证状态。

## 2. 可扩展订阅能力

当前 V1 只有连接同步的服务端投影，但 Desktop 状态不把它写死为唯一能力。`capabilities` 使用稳定的字符串 `code` 列表：

```json
{
  "code": "connection_sync",
  "phase": "active",
  "available": true
}
```

后续增加 AI 同步、设置同步或其他 Cloud 能力时，由 Cloud 服务端返回新的能力投影并追加列表项。套餐代码、订阅状态和能力代码都保持可扩展字符串；Desktop 不把 Plus、Free 或某个能力名称硬编码为完整权益集合。

能力的详细权限、配额、生命周期和快照仍由 Cloud 返回的具体 entitlement 投影负责。`capabilities[].available` 只能用于展示，不能作为脱离 Cloud 的授权依据。

## 3. Tauri 通信契约

通信方向采用 Tauri 的请求/投影模式：

```text
React ── invoke(get_cloud_desktop_state) ──► Rust
React ── invoke(refresh_cloud_desktop_state) ► Rust ── Cloud
React ── invoke(具体操作命令) ─────────────► Rust ── Cloud/SQLite/Keychain

Rust ── emit(cloud-desktop-state-changed, projection) ──► React
```

初始进入页面时，React 先调用 `get_cloud_desktop_state` 获取当前 Rust 快照。Rust 在快照为空、没有进行中的实时刷新且当前身份已认证时，可以先从磁盘展示缓存水合快照；这个路径不访问 Cloud，也不授权任何操作。缓存水合不能覆盖 `refreshing` 或已经建立的 Cloud 实时投影，避免页面在一次正常刷新过程中短暂显示“暂时离线”。桌面进程内只建立一个 Cloud 状态 event bridge，多个 React 页面共享同一个外部快照和订阅，不会因为页面分别挂载而重复注册监听器。

实时刷新调用 `refresh_cloud_desktop_state`。Rust 更新状态、完成 Cloud 权威读取或记录失败后，通过 `cloud-desktop-state-changed` 推送完整快照。完整快照事件可以让账户卡片、Cloud 概览和同步与安全页面同时收敛到同一个状态，不依赖组件之间互相传递 React 状态。

旧的窄 IPC 和 `cloud-sync-runtime-changed` 事件在迁移期间保留兼容，但新的页面路径统一消费 Cloud Desktop 快照。

## 4. React 保留范围

React 可以保留纯界面状态：

- Dialog 是否打开；
- 输入框和设备名称草稿；
- Recovery Key 确认步骤；
- 当前展开的冲突项和选中的决策；
- 按钮的局部交互反馈。

React 不应自行推导或持有以下业务状态：

- Cloud 是否已连接、离线或需要重新认证；
- 本机同步是否启用；
- 是否允许新增设备、恢复或删除同步数据；
- 同步运行阶段、冲突数量和待处理操作数量；
- 订阅名称对应的完整权益集合。

按钮可以根据 Rust 投影做展示级禁用，但 Rust 命令必须再次使用当前 Cloud 权威状态校验，不能把 React 投影当作授权依据。

## 5. 缓存与刷新

Rust 磁盘缓存只用于展示优化。页面进入时先展示 Rust 已有快照，再触发后台刷新；缓存来源必须标记为 `source=cache`。刷新失败不应把旧缓存伪装成实时状态，也不应通过全局遮罩阻塞页面。

多个页面在短时间内请求刷新时，Tauri 客户端共享同一个进行中的请求；账户卡片每次打开仍可主动触发刷新。Cloud 状态投影的更新时间和缓存来源由 Rust 快照统一提供，React 不再自行维护另一份 Cloud 上次更新时间。

### 5.1 Cloud 账户状态的联网刷新时机

账户状态刷新和同步运行是两条独立链路。账户状态刷新通过
`refresh_cloud_desktop_state` → Rust `sync_setup_context()` 完成；一次权威刷新会并行读取账户 Bootstrap、订阅/权益、同步状态，并在同步已初始化时读取设备列表。

| 触发场景 | 行为 |
| --- | --- |
| 应用启动 | 若恢复出已认证的 NIEEX Account 会话，Rust 在该次启动中后台执行一次权威刷新；页面可先读取内存或磁盘展示缓存，不等待网络完成 |
| 页面首次读取 | `get_cloud_desktop_state` 先读取 Rust 内存快照；没有 context 时可以水合磁盘展示缓存，此路径不联网 |
| 打开账户卡片 | 对当前已认证账号执行一次强制刷新（`force=true`） |
| 进入 Cloud 概览或同步与安全 | 执行非强制刷新；已有成功刷新且距完成时间不足 10 秒时复用共享快照，否则联网刷新 |
| 账号登录、切换或认证身份变化 | 当前页面若需要 Cloud context，会按新身份重新刷新；旧身份的快照和迟到响应不得复用 |
| 页面中的重试/刷新按钮 | 强制联网刷新，绕过 10 秒界面请求去重 |
| 启用同步、手工同步、暂停/恢复、撤销、恢复或删除同步数据等操作完成后 | 由操作页面主动重新读取 Cloud 状态，使账户和同步展示收敛到最新投影 |
| 状态栏刷新、普通 React 重绘、窗口前后台切换本身 | 不触发账户状态联网刷新 |

启动刷新由认证会话恢复为 `authenticated` 后触发；进程内门闩确保一次应用启动只安排一次，因此不在未登录状态联网，也不依赖用户打开 Cloud 页面。当前没有账户状态的定时轮询、后台常驻刷新或推送刷新。多个界面同时请求时，Tauri 客户端共享同一个进行中的请求；刷新失败时保留可用的展示缓存，但缓存不能作为授权依据。

### 5.2 Cloud 同步的 Rust 调度触发时机

同步由 Rust `CloudSyncScheduler` 独立调度，Frontend 只通过 `CloudDesktopStateProjection.runtime` 读取结果。每次真正执行同步前，Rust 都会重新从当前 NIEEX Account 和 Cloud 读取当前账户/设备/同步权限，不能使用本地缓存直接授权。

| `CloudSyncTrigger` | 触发场景 | 默认行为 |
| --- | --- | --- |
| `startup` | 应用启动且存在已认证身份 | 立即安排一次同步 |
| `authentication` | 登录成功或认证身份切换 | 取消旧身份任务并立即同步 |
| `foreground` | 窗口从后台恢复到前台 | 延迟 50ms 后同步；只对实际后台→前台转换触发 |
| `local_change` | 连接或连接文件夹新增、修改、删除、排序 | 750ms 防抖并合并连续修改后同步 |
| `manual` | 用户点击“立即同步” | 取消排队任务并立即执行一次 |
| `resume` | 用户从“暂停同步”恢复 | 立即安排一次同步 |
| `retry` | 可重试的同步失败 | 按 5s、15s、60s、300s 上限自动重试 |

暂停同步会取消排队任务并保持 `paused`；永久撤销、退出登录、切换账户或删除 Cloud 同步数据会取消旧任务并停止该身份的同步。状态栏和 Cloud 设置页不会自行启动同步。

一次同步的业务校验和数据处理仍由 Rust 完成：先确认账户、同步初始化、设备授权、本地 Keychain 密钥、读写权限和配额，再按上传/删除、增量拉取的顺序处理本地事实。同步运行结果通过 `cloud-sync-runtime-changed` 和统一 Desktop 状态事件投影到 React。

## 6. 状态更新触发点

Rust 状态投影在以下事件更新：

- NIEEX Account 认证、退出和重新认证；
- Cloud 展示状态刷新成功、缓存回退或永久失败；
- 同步调度器启动、前台恢复、本地变更、重试、手动同步、暂停和恢复；
- 设备授权、Recovery Key 恢复、设备撤销；
- 本地 SyncKeyStore 可用性变化；
- 同步冲突和本地操作投影变化。

没有账户状态或同步数据的后台轮询、推送要求。唯一的短期例外是请求端打开“等待设备批准”对话框时：它每 3 秒查询自己已暂存的授权请求；收到批准后立即领取信封并停止轮询。完成、取消、过期、关闭对话框或离开页面也会停止该轮询。UI 进入页面和用户主动操作分别通过窄 IPC 请求快照或触发刷新。
