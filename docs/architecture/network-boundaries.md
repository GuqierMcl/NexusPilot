# Nexus Pilot: 前后端网络请求边界与职责划分原则

## 1. 核心架构准则 (The Golden Rule)

在 Tauri (React + Rust) 架构中，前端（WebView）本质上是一个受限于 W3C 标准和安全策略的浏览器沙盒。界定网络请求归属的唯一标准是：

> **突破浏览器沙盒限制、涉及底层网络协议或核心机密的请求，必须交给 Rust；纯展示、不携带认证凭据且安全的 HTTP 交互，留给 React。**

补充规则：公开 HTTP 资源虽然默认可以由 React 请求，但如果该请求需要复用 Tauri 原生配置、写入系统级缓存、支持离线读取，或与自动更新等原生能力绑定，则应收敛到 Rust command，由前端通过 IPC 获取结果。

---

## 2. 必须交由 Rust 端的请求 (The Rust Domain)

前端无能为力或不应接触的领域，由 Rust 作为核心引擎在幕后静默处理。

* **底层物理数据库连接 (TCP/UDP)**
  * **场景**：连接 MySQL (3306)、PostgreSQL (5432)、Redis (6379) 等。
  * **原因**：浏览器环境无法发起原始的 TCP 套接字握手。
  * **实现**：使用 Rust 侧的 `sqlx`、`redis-rs` 建立并维护全局连接池。数据库 SSL/TLS mode 映射也属于 Rust engine 职责；前端只保存和校验配置字段。
* **桌面账号认证、Provider 头像与携带账号凭据的业务请求 (HTTPS)**
  * **场景**：OIDC Discovery、Authorization Code Exchange、Refresh、标准 `picture` 头像获取，以及携带 NIEEX Account Access Token 的 NexusPilot Cloud API。当前退出是纯本地操作，不发送 Revocation/End Session 网络请求。
  * **原因**：Refresh Token、Access Token、ID Token、Authorization Code、PKCE verifier、state 和 nonce 都不属于 WebView 安全边界；CORS 是否允许不改变凭据敏感性。
  * **实现**：系统浏览器只负责 Provider 交互，Deep Link 回调进入 Rust AuthManager；React 只通过 Auth IPC 获取脱敏 `AuthSessionSnapshot`。Provider `picture` URL 仅在 Rust 内部短暂存在，由 Rust 执行 HTTPS/地址/重定向/格式/尺寸检查、重编码和原生缓存；WebView 只读取本地 PNG，不直接加载远程头像。Cloud 请求由 Rust-only `CloudTokenBroker` 复用 AuthManager 的串行 Refresh，再由固定目标的 `CloudApiClient` 注入 Bearer Token；React 只可调用业务级窄 IPC，当前 `bootstrap_cloud_account` 返回内部账户和权益投影。任何阶段都不提供 Access Token IPC。
  * **Cloud 状态展示缓存**：Phase 8A 允许 Rust 将最近一次完整成功的账户/订阅/权益/同步状态和设备脱敏投影保存为独立的本地展示缓存。断网或 Cloud 暂时不可用时，Rust 可通过带 `source=cache`、`cachedAt` 的窄 IPC 返回该投影，使设置页保持可读；缓存不具备授权能力，不能驱动同步、设备变更、配额判断或其他 Cloud 业务动作。登录账户切换或退出时必须隔离/清理旧账户缓存，且缓存不得包含 Token、JWT、身份 Claim、密钥、Device Proof、密文或连接凭据。
* **操作系统级网络代理**
  * **场景**：通过跳板机连接生产环境数据库。
  * **原因**：涉及底层的 SSH 端口转发（Port Forwarding）。
  * **实现**：Rust 建立 SSH 隧道，将远端端口映射至 `localhost`。前端不得自行打开 SSH、TCP socket 或处理 host key trust；它只提交 `sshTunnel` 配置，后端负责认证、host key fingerprint 校验、端口转发与隧道生命周期。
* **需要原生缓存或 Tauri 配置复用的公开 HTTP 资源**
  * **场景**：应用设置“关于”页读取当前安装版本的 `notes.md` 发布日志。
  * **原因**：发布日志本身是公开静态资源，但请求地址需要从 Tauri updater endpoint 派生，结果需要按安装版本写入系统缓存，并在离线或重复打开设置页时复用。
  * **实现**：前端调用 Rust IPC command；Rust 从 `tauri.conf.json` 的 updater 配置派生 public base URL，使用 Tauri HTTP plugin 发起请求，并把 `vX.Y.Z/notes.md` 按版本缓存到 app cache 目录。

---

## 3. 必须交由 AI Runtime 的请求 (The AI Runtime Domain)

AI Provider、Agent orchestration 与 Runtime Tool 属于本地 `ai-runtime` sidecar，不再由 React 或 Rust Tauri command 代发：

* **LLM Provider API (HTTPS)**
  * **场景**：调用 OpenAI、Anthropic 或 OpenAI-compatible Provider，执行模型、tool calling 和 AI SDK-compatible stream。
  * **原因**：LLM credential 不得进入 WebView；AI Runtime 已经拥有 Provider/Model 配置、Run、Store、Policy 和 AI SDK adapter。
  * **实现**：Frontend 通过 `POST /v1/runs` 调用 AI Runtime；AI Runtime 持有 credential 并直接请求 Provider。Rust 不读取 LLM credential，也不代理正常模型流量。
* **Runtime-local Tool 网络请求**
  * **场景**：受控 `web.fetch`、`web.ping` 等只属于 AI Runtime 的工具。
  * **实现**：由 AI Runtime 在 Tool Policy、每 Run 冻结的网络访问范围、timeout 和 output limit 下执行，不绕行 Rust。默认 `local-and-public` 允许本机可达的公网、内网、VPN、容器网络和 localhost，符合本地桌面工作台对开发和数据库诊断的需要；可在“设置 → AI 能力 → 偏好设置”切换为 `public-only`。后者才启用严格 SSRF 边界：拒绝 loopback、private、link-local、reserved 地址、解析到这些地址的 hostname 与逐跳重定向目标，并保留普通域名的标准 IPv4 `198.18.0.0/15` 和 Mihomo IPv6 `fdfe:dcba:9876::/64` TUN Fake-IP 兼容路径。无论范围如何，`web.fetch` 只读取 HTTP(S) 内容且不携带调用方凭据；`web.ping` 只运行固定参数的单 host/IP ICMP 诊断，不能成为端口扫描或任意 shell 命令入口。
* **需要 Rust 后端能力的 Agent Tool（目标边界）**
  * **场景**：读取连接列表、数据库 metadata 或后续受控 Workbench operation。
  * **实现**：AI Runtime Core 先完成 Tool Snapshot、Risk、Permission 和 limit 检查，再通过内部 Backend WebSocket Bridge 调用 Rust Gateway。Frontend 不代理该请求；AI Runtime 也不自行持有数据库连接池。

AI Runtime 相关的三条通信通道不得混用：Frontend EventBus/SSE 只传递可丢弃 UI 通知，Rust Backend WebSocket Bridge 交换后端 command/response，Frontend 使用 `/health` 查询 Runtime 健康。通道边界见 [communication-boundaries.md](../ai-runtime/communication-boundaries.md)，Bridge 与 Rust Gateway 的具体设计见 [backend-bridge.md](../ai-runtime/backend-bridge.md)。

---

## 4. 适合交由 React 端的请求 (The React Domain)

前端可以完全自治的领域，利用现有的 Web 生态（`axios`, `fetch`）提升开发效率。

* **标准且无跨域限制的匿名 RESTful/GraphQL API**
  * **场景**：己方服务提供的不需要账号凭据的公开目录、状态或展示数据。
  * **原因**：请求不携带 Token 或其他核心机密，且服务端正确配置 CORS。
  * **实现**：前端可以直接使用 `fetch` 配合 TanStack Query 拉取数据。资产同步、购买授权等需要登录身份的业务不属于该条，必须回到 Rust 账号凭据边界单独设计。
* **公共静态资源与开放数据**
  * **场景**：拉取 Github Release 检查应用更新、加载外部 CDN 图标或帮助文档。
  * **原因**：纯公开 HTTP 资源，安全且无限制。
  * **边界**：如果公开资源需要系统级缓存、离线读取、复用 Tauri 配置，或需要与原生更新流程共享事实来源，则不要直接在 React 中请求，应交给 Rust command。
* **桌面应用更新检查**
  * **场景**：Tauri updater 插件拉取私有 HTTPS `latest.json` 与签名工件，完成启动检查和手动检查更新。
  * **原因**：更新资源是公开可下载的静态文件，但更新流程需要走 Tauri 原生 updater 插件，且必须保持签名校验与后台静默检查。
* **跨端内部通信 (IPC)**
  * **场景**：从 SQLite 读取本地连接配置、通知 Rust 执行 SQL。
  * **实现**：数据库 Workbench 主路径将 Tauri 的 `invoke` 封装为统一 `apiClient`；AI 面板则使用 AI Runtime endpoint discovery 后访问 `/health`、`/v1/runs`、Snapshot API 和 EventBus/SSE。Frontend 不连接目标 Backend WebSocket Bridge。

---

## 5. 开发者决策树 (Decision Tree)

在编写任何数据获取逻辑前，请在脑海中执行以下三步检查：

0. **AI Runtime 领域判定：这是模型调用、Agent Run 或 Runtime Tool 吗？**
    * 是，且可由 AI Runtime 本地完成 ➡️ **交给 AI Runtime**
    * 是，但需要数据库/Workbench 后端能力 ➡️ **AI Runtime Core 通过 Backend Bridge 调用 Rust Gateway**
    * 否 ➡️ 下一步
1. **协议判定：这是 HTTP/HTTPS 请求吗？**
    * 否（如 TCP 协议） ➡️ **交给 Rust**
    * 是 ➡️ 下一步
2. **安全判定：请求是否会被 CORS（跨域）拦截？**
    * 会（如未开放的第三方 API） ➡️ **交给 Rust（作为代理）**
    * 不会 ➡️ 下一步
3. **涉密判定：非 AI Runtime 请求是否需要携带不能暴露在前端的敏感凭据（如 Access Token、Refresh Token 或 ID Token）？**
    * 是 ➡️ **交给凭据所属的可信进程；当前桌面账号凭据属于 Rust**
    * 否（匿名或纯公开请求） ➡️ 下一步
4. **原生能力判定：是否需要系统级缓存、离线读取、Tauri 配置复用或与 updater 等原生能力绑定？**
    * 是 ➡️ **交给 Rust（通过 IPC 暴露窄口结果）**
    * 否 ➡️ **留在 React**
