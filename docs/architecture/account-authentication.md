# 账号认证与桌面 Deep Link

本文档描述 NexusPilot 可选账号登录基础设施的当前实现事实。登录身份为 NIEEX Account：NIEEX 是 NexusPilot 所属品牌，该统一账号也可用于其他 NIEEX AI 应用。当前行为、存储边界和验收状态以本文档和代码为准。

## 1. 当前状态

第一阶段账号认证纵向闭环已经实现，当前代码可以从标题栏打开系统浏览器，在 Logto 完成 Authorization Code + PKCE 登录，通过桌面 Deep Link 回到 Rust，将长期凭据保存到系统 Keychain，并在后续启动时自动恢复。2026-07-18 已由用户使用正式 NSIS 安装包完成 Windows Deep Link 与真实 Logto 基础登录验收；2026-08-05 又确认 Keychain cutover 后的 Windows 开发环境能够完成真实登录。两项手工事实均不替代自动化安全、正式安装包 Keychain、重启恢复与退出回归测试。

| 能力 | 当前状态 |
| --- | --- |
| 产品 Identifier | 继续使用 `NexusPilot`，不迁移现有安装与数据目录 |
| 桌面自定义 Scheme | 已配置 `dev.nexuspilot`，与产品 Identifier 解耦 |
| single-instance 协作 | 已启用 `deep-link` feature，且保持首插件顺序 |
| 通用 Rust Router | 已支持精确路由注册、Handler trait、晚绑定和有界暂存 |
| 冷启动 URL 获取 | 已通过 Rust `get_current` 接入 |
| 运行中 URL 监听 | 已通过 Rust `on_open_url` 接入 |
| Auth 路由 | 已注册 `/callback` 与 `/signed-out`，由 Rust-only Handler 交给 AuthManager |
| Provider 公开配置 | 已嵌入 Issuer、Client ID、Redirect URI、身份 Scope、Cloud Resource/Scope 和稳定 fingerprint |
| 登录可选的失败隔离 | 已实现；注册、校验或启动 URL 读取失败不阻止本地工作台 |
| OIDC Adapter / AuthManager / Keychain | 已实现 Standard OIDC、长期会话与系统安全凭据存储适配 |
| 启动恢复 / Rotation / 退出 | 已实现；Refresh 串行化，退出只清理本地会话且不访问 Provider 或打开浏览器 |
| Auth IPC / Account Card | 已实现安全 Snapshot、脱敏事件与标题栏账号卡片 |
| Provider 头像 | 已实现标准 `picture` 映射、Rust 安全下载/净化、本地 PNG 缓存与首字母降级 |
| Windows 正式安装包验证 | 已通过；NSIS 全部用户安装、HKLM 注册、冷/热启动、单实例与卸载清理均正常 |
| Windows 开发环境 Keychain 登录 | 已通过；2026-08-05 确认 Keychain cutover 后可完成真实 NIEEX Account 登录 |

登录是可选能力；未登录和认证失败不得影响本地数据库工作台、AI Runtime 或本地配置。

## 2. 真实 Provider 配置

随应用发布的公开配置位于：

```text
src-tauri/auth-provider.json
```

当前配置：

```text
schemaVersion = 2
configId = nexuspilot-account-production-v3
displayName = NIEEX Account
issuer = https://auth.nieex.com/oidc
clientId = tpg7jhxz09x0y9z5fcav7
redirectUri = dev.nexuspilot://auth/callback
postSignOutRedirectUri = dev.nexuspilot://auth/signed-out
identityScopes = openid profile email offline_access
cloudResource.indicator = https://api.nexuspilot.dev
cloudResource.scopes = cloud:access
```

Logto Console 中的 Native Application 必须允许登录回调；旧版本已经配置的退出回调可以兼容保留：

```text
dev.nexuspilot://auth/callback
dev.nexuspilot://auth/signed-out
```

其中只有 `dev.nexuspilot://auth/callback` 属于当前登录必需配置；纯本地退出不会导航到 `dev.nexuspilot://auth/signed-out`。

截至 2026-08-05，NexusPilot 已从最初真实联调使用的 Logto Third-party Native App 切换为 NIEEX 自有的**第一方 Native App / Public Client**。Native/Public 表示 Desktop 不能保存 Client Secret，继续使用 Authorization Code + PKCE；第一方表示 NexusPilot 由 NIEEX 开发和控制，不再使用第三方应用的 Permission allowlist/Consent 作为额外信任门槛。API Resource 与 RBAC 边界保持不变：Desktop 仍只请求 `resource=https://api.nexuspilot.dev` 和 `cloud:access`，用户仍必须通过全局 User Role 获得该 Permission。

旧 Third-party App 在 Phase 1 首次真实 Bootstrap 中曾因未配置“权限 → 授予用户数据权限 → `cloud:access`”而得到 `insufficient_scope`；补齐应用 allowlist 后已完成原链路验收。该事实只作为迁移历史和错误诊断依据，不是第一方应用的当前配置步骤。2026-08-05 已由用户确认新第一方应用能够完成真实登录；旧应用只在其余内测用户完成升级前保留用于回滚，随后再由管理员撤销旧 Grants 并退役。

当前协议契约只接受 `dev.nexuspilot://...`，不兼容任何旧 Deep Link scheme。更新 Console 配置后，应先保存并确认配置生效，再进行真实登录或退出回调测试。

配置不包含 Client Secret，不允许前端、Deep Link 或运行时 Query 覆盖。Rust 启动时验证 Schema、HTTPS Issuer、固定 Redirect URI、固定 Cloud Resource 和固定 Scope；无效配置只禁用账号登录，不阻止本地工作台。Provider fingerprint 使用以下字段及两个有序 Scope 列表的稳定 SHA-256：

```text
schemaVersion + configId + issuer + clientId + redirectUri
+ identityScopes[] + cloudResource.indicator + cloudResource.scopes[]
```

Schema v2 是 Cloud API audience/scope cutover。它与 v1 fingerprint 不同，因此升级后旧 Keychain Session 会 fail closed，用户需要重新登录一次；不读取或迁移旧 Refresh Token，也不影响 SQLite、本地连接和工作台数据。

第一方应用配置保持 `schemaVersion = 2`，因为 Provider JSON 结构和 Cloud Resource 契约未改变；当前 `configId` 为 `nexuspilot-account-production-v3`，并使用第一方 `clientId`。Provider fingerprint 同时包含 configId 和 clientId，因此不匹配的 Keychain Session 会按现有机制 fail closed，用户重新登录即可，不实现双 Client 或 Refresh Token 迁移。当前 Logto Discovery 声明 `subject_types_supported = public`，Cloud 只以 `issuer + subject` 关联内部账户。Cloud 账户连续性、重启恢复和本地退出必须作为发布回归项持续验证，不能仅依据 Client 配置推断通过。

Logto Console 必须创建全局 API Resource：

```text
name = NexusPilot Cloud API
indicator / JWT aud = https://api.nexuspilot.dev
permission = cloud:access
建议用户角色 = NexusPilot Cloud User
```

参与 Cloud 联调的用户必须通过全局 User Role 获得 `cloud:access`；Organization Role 或 M2M Role 不满足该用户级全局 API Resource 契约。Logto 的 Default Global Role 只自动授予设置生效后新创建的用户，不追溯历史用户；既有内测用户必须在 Role 和 User 两侧确认关联。不要把 `/v1` 加入 indicator，也不依赖 Logto 的“默认 API Resource”：Desktop Authorization Request 显式发送 `resource=https://api.nexuspilot.dev`，并请求 `cloud:access`；后续 Authorization Code Token Exchange 与 Refresh Request 同样显式保持该 resource。Free/Plus、同步开关、设备数和密文配额不进入 OAuth Scope，仍由 NexusPilot Cloud 权益引擎判断。

2026-07-18 根据用户提供的 Logto 控制台截图并通过真实 Discovery 验证：

| 元数据 | 值 |
| --- | --- |
| Issuer | `https://auth.nieex.com/oidc` |
| Discovery | `https://auth.nieex.com/oidc/.well-known/openid-configuration` |
| Authorization Endpoint | `https://auth.nieex.com/oidc/auth` |
| Token Endpoint | `https://auth.nieex.com/oidc/token` |
| JWKS URI | `https://auth.nieex.com/oidc/jwks` |
| UserInfo Endpoint | `https://auth.nieex.com/oidc/me` |
| Revocation Endpoint | `https://auth.nieex.com/oidc/token/revocation` |
| End Session Endpoint | `https://auth.nieex.com/oidc/session/end` |
| PKCE | `S256` |
| 必需 Grant | `authorization_code`、`refresh_token` 均已声明 |
| Public Client Auth | Token Endpoint 声明支持 `none` |
| 头像 Claim | Discovery 声明支持标准 `picture`，由 `profile` Scope 获取 |

除 Issuer 和 Client ID 外，Endpoint 不硬编码；Standard OIDC Adapter 必须在运行时从 Discovery 获取并验证，以保留未来整体更换认证平台的能力。

## 3. 通用桌面 Deep Link Router

Deep Link 是桌面端通用基础设施，不是 Logto 专用模块，也不包含移动端实现。模块关系：

```text
Tauri deep-link plugin
  -> DesktopDeepLinkRouter
       -> 精确 route(host + path)
       -> Arc<dyn DesktopDeepLinkHandler>
            -> 当前：AuthDeepLinkHandler -> AuthManager
            -> 未来：其他桌面功能 Handler
```

业务模块通过以下抽象接入：

- `DesktopDeepLinkRoute`：稳定 route id、精确 host、精确 path；
- `DesktopDeepLinkHandler`：Rust-only 处理器 trait；
- `DesktopDeepLinkRequest`：携带 route、来源和原始 URL，不实现 `Debug`；
- `DesktopDeepLinkSource`：区分冷启动 `Launch` 和运行中 `Runtime`；
- `DesktopDeepLinkDispatchOutcome`：Delivered、Queued、Rejected 或 HandlerRejected；
- `DesktopDeepLinkRegistrationStatus`：BundleManaged、Registered 或 Unavailable。

Router 不理解 OIDC、Token、窗口、数据库或 Cloud 业务。未来增加其他 Deep Link 功能时，由对应 Rust 模块注册新的精确 route 并附加自己的 Handler，不修改认证 Handler，也不把原始 URL 交给 React。

## 4. 路由、安全与晚绑定

Tauri 静态配置声明桌面 Scheme：

```text
dev.nexuspilot
```

认证模块当前注册：

```text
routeId = auth.callback
URL = dev.nexuspilot://auth/callback

routeId = auth.signed-out
URL = dev.nexuspilot://auth/signed-out
```

Router 在查找业务 route 前统一拒绝：

- 非 `dev.nexuspilot` Scheme；
- 缺少 Host；
- userinfo/嵌入式凭据；
- 端口；
- fragment；
- 超过 8 KiB 的 URL；
- 未显式注册的 Host/Path；
- 额外路径或尾部 `/`。

每个 route 在 Handler 尚未附加时最多暂存 8 条 URL，超限丢弃最旧项。Handler 附加后按到达顺序自动排空；排空期间新 URL 继续进入该 route 队列，不会越过更早的冷启动请求，调用 Handler 时也不持有 Router 锁。认证模块附加 `AuthDeepLinkHandler` 后，将合法 URL 交给 AuthManager 的串行会话操作；AuthManager 执行 Pending Login 过期、Provider fingerprint、state、可选 `iss`、nonce、PKCE 和一次性 Code Exchange 校验。错误 state 不消费合法 Pending Login，已接受的回调会先持久移除 Pending Login，再尝试交换 Code，避免重复使用。

URL、Authorization Code、state 和 Provider 错误不会写入通用日志。日志只包含来源、稳定 route id、拒绝原因代码和是否发生有界队列淘汰。

## 5. Tauri 与 single-instance 顺序

Windows/Linux 上 Deep Link 会以新进程参数进入应用，因此插件初始化保持：

```text
tauri-plugin-single-instance（必须第一）
  -> tauri-plugin-deep-link
  -> 其他插件
```

`tauri-plugin-single-instance` 启用了 `deep-link` feature。第二实例收到 URL 时，插件先触发 Deep Link 事件，再由既有单实例回调恢复、显示和聚焦 `main` 窗口。

通用 `single-instance` 事件仍可向 WebView 转发普通启动参数，但会移除所有 `dev.nexuspilot:` 参数，避免 OAuth Authorization Code 和 state 通过通用激活事件进入 React。

Rust 同时覆盖：

- 应用由 Deep Link 冷启动：Tauri setup 中读取 `get_current`；
- 应用已经运行：通过 `on_open_url` 接收插件事件。

## 6. 平台注册与失败隔离

- Windows 正式构建：由 NSIS/WiX 安装包根据静态配置注册 Scheme；应用启动只检查关联，不覆盖安装结果；
- Windows Debug：调用 `register_all`，使协议指向当前调试可执行文件；
- Linux：调用 `register_all`，覆盖未使用 AppImage launcher 或 AppImage 移动后的场景；
- macOS：不支持运行时注册，依赖 `.app` Bundle；第一阶段不做真实 macOS 安装包验收；
- 移动端：不在本基础设施范围内。

以下失败均只把 Router 标记为 `Unavailable` 并记录脱敏诊断，不从 Tauri setup 返回错误：

- `register_all` 失败；
- `is_registered` 返回 false；
- 无法读取注册状态；
- `get_current` 失败；
- Auth route 或 Handler 注册失败；
- 内嵌 Provider 配置无效。

因此 Deep Link、Logto、Cloudflare、Linux 桌面工具或系统协议关联故障不会阻止 SQLite、连接工作台、设置、窗口状态或 AI Runtime 初始化。账号卡片根据 AuthManager 投影显示“登录暂不可用”或“身份已保留，账号服务暂时不可用”，不暴露 Router 或 Provider 的原始错误。

## 7. WebView 权限边界

Deep Link 使用 Rust API 接收，不向 desktop capability 授予 `deep-link:default`。React 不调用 JavaScript `getCurrent` 或 `onOpenUrl`，也不读取原始回调 URL。

前端只通过 Auth IPC 和 `auth-session-changed` 脱敏事件获得：

- 会话阶段；
- 用户公开资料；
- 是否需要重新登录；
- 是否暂时无法登录；
- 可安全展示的错误信息。

Access Token、Refresh Token、ID Token 原文、Authorization Code、PKCE Verifier、state、nonce 和完整 Callback URI 不属于前端契约。

## 8. Standard OIDC 与 AuthManager

`StandardOidcProviderAdapter` 只依赖公开 Provider 配置和标准 Discovery，不包含 Logto SDK、Logto 专用 Endpoint 或 Client Secret。更换认证平台时由产品发布新的单一 Provider 配置；用户不能在 UI 中选择 Provider。已持久会话使用 Provider fingerprint 绑定，Issuer、Client ID 或 config identity 变化时 fail closed，并要求重新登录，本地工作台数据不迁移也不删除。

OIDC 最低能力为：

- Authorization Code Flow；
- Public Client token auth method `none`；
- PKCE `S256`；
- `authorization_code` 与 `refresh_token` Grant；
- `openid profile email offline_access` Scope；
- RFC 8707 `resource=https://api.nexuspilot.dev` 与 API Resource Scope `cloud:access`；
- 公开密钥 ID Token 签名算法；不允许 `none` 或基于共享 Client Secret 的 HMAC；
- 严格 HTTPS Discovery、Authorization、Token、JWKS 和 UserInfo Endpoint；Discovery 中的 Revocation 与 End Session 元数据不参与当前纯本地退出。

HTTP 客户端禁止重定向，连接超时 10 秒、总超时 20 秒，单个 OIDC 响应最大 256 KiB，并使用系统原生根证书的严格 TLS 校验。Authorization Request 同时发送身份 Scope、Cloud Scope 和显式 `resource`；Authorization Code Token Exchange 与 Refresh Request 均保持相同 resource，确保 Logto 签发 audience 为 Cloud API Resource 的 Access Token。Discovery 的 `scopes_supported` 只用于验证标准身份 Scope，因为 Logto 的 API Resource permissions 不会出现在该 OIDC 元数据字段中。ID Token 通过 Discovery/JWKS 验证签名、Issuer、Audience、`azp`、`exp`、`iat` 合理性、可选 `nbf`、nonce 和 subject；未知/轮换 Key 触发一次强制 Discovery/JWKS 刷新。UserInfo 必须与 ID Token subject 一致；UserInfo 暂时不可用时可回退到已经验证的 ID Token 公开 Claims。标准 `picture` 只形成 Rust 内部头像候选，不直接进入公开 `AuthUser`。Discovery 中即使存在 Revocation 或 End Session Endpoint，当前退出流程也不会调用它们。

AuthManager 是唯一认证事实来源。所有登录、回调、恢复、刷新和退出写操作经同一个异步互斥锁串行化。Pending Login 保存 10 分钟；重复点击登录会复用同一未过期交易并重新打开相同授权页，不创建并行 state。前端不能直接刷新 Token，也不存在返回 Access Token 的 IPC。

### 8.1 Rust-only Cloud Token 借出

Cloud V1 不改变上述事实来源。`AuthManager::usable_access_token()` 是仅 crate 内可见的可信调用接口，不是 Tauri command：

```text
Cloud 请求到达 Rust
  -> 获取 AuthManager 原有 operation lock
  -> 当前 RuntimeTokens 距过期大于 60 秒：复制 SecretString
  -> Token 缺失或进入刷新窗口：调用现有 refresh_current_session
  -> Rotation 先写 Keychain 并复读成功
  -> 从新的 RuntimeTokens 复制 SecretString
  -> 交给 CloudApiClient 构造 Authorization Header
```

因此多个并发 Cloud 请求最多触发一次 Refresh Rotation；后续等待者取得首个刷新产生的新 Access Token。该接口不读取 Keychain、不返回 Refresh Token、不修改 Provider 契约，也不建立 Cloud 专属刷新锁。匿名、账号服务临时不可用和必须重新登录分别映射为 Rust 内部状态，再由 Cloud IPC 转成稳定脱敏错误。退出在同一 operation lock 下清除会话和 Runtime Token 后，后续 Cloud 请求无法再取得 Token。

Access Token 的借出值仍为 `SecretString`，不实现明文 `Debug`，只用于一次 Rust HTTP 请求。Cloud 401 不会把 JWT 或原始响应传给 React；它映射为需要重新登录的 Cloud 错误，也不能由 WebView 强制刷新或索取 Token。当前第一方应用收到 Cloud 403 `insufficient_scope` 时，表示 Logto resource、全局 User Role、用户角色绑定或新 Authorization Grant 至少有一层没有产生最终 scope；它不是 Free 权益，也不能被客户端当作 `not_entitled`。只有排查已经退役的旧 Third-party App 时，才额外检查应用 permission allowlist 与 Consent。

## 9. 当前实现：系统 Keychain 与本地头像缓存

长期认证凭据已从应用数据目录中的自治文件 Vault 切换到操作系统安全凭据存储：Windows Credential Manager、macOS Keychain、Linux Secret Service / 系统 keyring。`AuthManager` 只依赖 NexusPilot 定义的 `AuthCredentialStore`；生产环境注入 `SystemAuthCredentialStore`，自动化测试使用内存实现和可故障注入的凭据后端。平台 Keychain API 不进入 Tauri command、React 或 Cloud 同步领域。

生产条目使用稳定且版本化的 service/account 二元组；Debug 与 Release 隔离，避免 `tauri dev` 覆盖正式安装版凭据：

```text
Release service = NexusPilot.Auth.v1
Debug service   = NexusPilot.Auth.dev.v1

accounts:
  refresh-token
  session-metadata
  pending-login
```

每条记录均为独立的 versioned JSON，写入前限制为 2048 UTF-8 bytes，并在写入后从 Keychain 重新读取、逐字节验证。Session Metadata 和 Refresh Token 使用随机 `generation_id`、Provider fingerprint、issuer 与 subject 互相绑定；缺条目表示正常匿名，Schema 不支持、字段缺失、记录损坏或跨 generation 拼接一律 fail closed。Refresh Token 与 Pending Login 的反序列化临时字段在 Drop 时 zeroize，相关结构不实现 `Debug`。

Keychain 只持久保存最小公开用户资料、Refresh Token 和未完成登录交易。Access Token 仅存在于 Rust 进程内存；ID Token、Authorization Code 只在登录或刷新响应校验期间短暂存在，完成身份校验后不再保留。密码从始至终只进入 Logto 的系统浏览器页面。所有 Keychain load/write/clear 均通过 `spawn_blocking` 执行，不占用 Tauri UI 线程或异步 Runtime worker。

既有 `APP_DATA_DIR/auth/vault.bin` 与 `vault.key` 不检测、不读取、不迁移、不删除、不记录清理日志；Keychain 失败时也不会回退旧 Vault 或普通文件。没有 Keychain Session 的升级用户普通进入 `anonymous`，应用不显示“安全存储已升级”提示，也不自动打开浏览器。旧 Vault 文件只作为旧版本遗留物原样保留；回退到仍支持旧 Vault 的版本不属于受支持的认证会话安全路径。

头像缓存属于公开展示资源，不进入 Keychain，仍完全由 NexusPilot 在普通应用数据目录中自治管理。Rust 优先读取最新 UserInfo `picture`，回退到已验证 ID Token；Refresh ID Token 合法省略 `picture` 且 UserInfo 临时失败时保留最后一次有效缓存，只有 UserInfo 成功并明确缺少 `picture` 时才视为无头像。候选 URL 最大 2048 bytes，只允许标准 443 端口的 HTTPS，拒绝嵌入式凭据、fragment、单标签/本地域名、回环、私网、链路本地、文档和其他特殊地址。每次 DNS 解析及最多三次重定向都重新校验目标：非公网 DNS 答案永不用于连接，混合答案只固定并访问去重后的公网子集；但对于域名解析结果，允许 Clash/Mihomo TUN 的标准 Fake-IP IPv4 `198.18.0.0/15` 与 IPv6 `fdfe:dcba:9876::/64`，以便由本机 TUN 按域名路由请求。直接以 Fake-IP 字面量构造的 URL 仍被拒绝，其他私网、回环、链路本地、保留和文档地址也仍被拒绝。下载不携带 Token、Cookie、Referer 或系统代理，连接/总超时为 5/10 秒，响应最大 1 MiB，只接受 MIME 与内容一致的 JPEG、PNG、WebP。图片在 Rust 中限制源尺寸为 2048×2048、缩放到最大 256×256 并重新编码为无远程元数据的 PNG，缓存文件最大 512 KiB。

公开 Snapshot 只保存由 Provider ID、Issuer、subject 与本地 PNG 内容共同计算的 SHA-256 `avatarRevision`。React 通过 `get_auth_avatar` 获取与当前身份和 revision 精确匹配的原始 PNG 字节；Tauri 当前原始响应应为 `ArrayBuffer`，前端在 IPC 边界仍防御性兼容 TypedArray 或字节数字数组并统一复制为 `Uint8Array`，再使用内存 Blob URL 展示。Provider 原始 `picture` URL 不进入 IPC、事件、Zustand 或 WebView。下载、解析、净化、缓存、IPC 竞态或离线失败均只降级为本地首字母 Avatar，不改变 `authenticated`、`providerAvailability` 或本地工作台状态。生产日志只记录 Claim 存在性、稳定阶段与失败代码，不记录原始 URL；登录/刷新会异步更新头像，离线恢复使用缓存，退出、Provider 更换或 Refresh 被拒绝时清除当前引用并尽力删除头像缓存文件。

## 10. Keychain 提交协议与失败关闭边界

本节记录当前 Keychain 实现必须保持的事务顺序和安全不变量。此次切换是一次凭据存储 cutover，不是旧凭据迁移。

Cloud V1 的 AMK 和设备私钥后续使用同一平台安全存储能力，但必须位于独立的 `SyncKeyStore` 领域接口和 Keychain 命名空间，认证模块不得直接访问同步密钥。

### 10.1 存储边界与条目

| 项目 | 当前存储 | 保留规则 |
| --- | --- | --- |
| Refresh Token | service `NexusPilot.Auth.v1` / account `refresh-token` | 只供 Rust AuthManager 使用；退出、Grant 失效或换账号时 Tombstone 后删除。 |
| Session Metadata | service `NexusPilot.Auth.v1` / account `session-metadata` | 保存 Provider fingerprint、已验证用户投影、时间和头像 revision，用于离线展示；不含 Access/ID Token。 |
| Pending Login | service `NexusPilot.Auth.v1` / account `pending-login` | 保存 transaction ID、state、nonce、PKCE verifier、授权 URL 和 10 分钟有效期；完成、取消、过期或退出时消费并删除。 |
| Access Token | 仅 Rust 内存 | 不持久化，不进入 Keychain、IPC 或 React。 |
| ID Token / Authorization Code | 仅 Rust 临时内存 | 完成身份校验或 Code Exchange 后释放。 |
| 净化头像 PNG | 普通应用数据目录 | 公开展示缓存；失败只降级为首字母，不影响认证。 |
| Cloud AMK 与设备私钥 | 后续独立 Keychain 命名空间 | 只在本机已认证且设备仍获授权时使用；不属于本次 Auth cutover。 |
| Recovery Key | 仅用户持有 | 不持久化到 Keychain、文件、Cloud、日志或前端状态。 |

Release Keychain service/account 名称稳定、版本化且不包含邮箱、昵称、subject 原文或 Token 片段；名称不包含 NexusPilot 应用版本，因此普通升级不会丢失会话。Debug 构建使用 `NexusPilot.Auth.dev.v1` 隔离开发凭据。条目 schema、Provider fingerprint、issuer、subject 和随机 `generation_id` 互相绑定。Windows Credential Manager 对单条 Generic Credential 有大小限制，因此 Refresh Token、Session Metadata 与 Pending Login 不聚合成一个大 JSON；每条记录在写入前执行 2048 UTF-8 bytes 上限检查，过长时 fail closed，禁止截断或回退文件。

### 10.2 无迁移、无清理、无升级提示

Keychain 版本对既有 `APP_DATA_DIR/auth/vault.bin` 和 `vault.key` 采用完全忽略策略：

```text
不检测是否存在
不打开或读取
不解密或导入
不删除或修改
不记录清理日志
不根据旧文件决定 Auth 状态
Keychain 失败时不回退读取
```

新版本启动只查询 Keychain；没有 Keychain Session 即进入普通 `anonymous`。产品不自动打开浏览器，也不显示“安全存储已升级”之类的专门提示。用户需要 Cloud 能力时自行点击 NIEEX Account 登录；SQLite 连接、工作台布局、AI Runtime 数据和其他本地资产天然不受影响。

旧 Vault 留在磁盘意味着认证会话不保证安全回退：用户若手动安装仍支持文件 Vault 的旧版本，旧版可能读取其中尚未失效的 Refresh Token；新版本退出也只清理 Keychain，不修改旧 Vault。该行为是明确的不支持场景，不为版本回退增加兼容或清理逻辑。

当前运行链路已经删除 `EncryptedFileAuthVault`、旧 Vault 加解密代码及 `chacha20poly1305` 专用依赖，没有保留不可达的 fallback adapter。

### 10.3 登录与回调提交顺序

开始登录必须先创建 Pending Login、写入 Keychain 并重新读取验证，成功后才打开系统浏览器。Keychain 写入失败时不得打开浏览器。重复点击登录只复用同一未过期、Provider fingerprint 匹配的 Pending Login，不创建并行 state。

Deep Link 回调从 Keychain 读取 Pending Login，验证有效期、Provider fingerprint、state、可选 issuer 后，先将交易标记为 consumed 并确认持久化，再执行 Authorization Code Exchange。错误 state 不消费合法交易；已接受的回调不得恢复 Pending Login 或重复使用 Authorization Code。

Token Exchange 与身份校验完成后按以下顺序建立长期会话：

```text
写入带新 generation_id 的 Session Metadata
        ↓
写入 Refresh Token，作为长期会话提交点
        ↓
重新读取并校验两条记录的 generation / identity / fingerprint
        ↓
Access Token 进入 Rust RuntimeTokens
        ↓
发布 authenticated AuthSessionSnapshot
```

任一步失败都不得发布登录成功或保留 Runtime Access Token，也不得把凭据写到普通文件。

### 10.4 恢复与 Refresh Token Rotation

启动恢复只读取 Keychain：无条目为正常匿名；完整且 fingerprint 匹配的 Session 使用 Refresh Token 获取短期 Access Token。临时网络失败保留 Keychain Session 和上次已验证用户投影，显示账号服务暂不可用；Refresh 被拒绝、身份校验失败、条目损坏或 generation 不一致时 fail closed、清除新 Keychain Session 并要求重新登录。

Provider 返回旋转后的 Refresh Token 时，AuthManager 必须先原子替换 Keychain Refresh Token 并重新读取验证，成功后才更新 Runtime Access Token 和公开 Snapshot。保存失败时旧 Token 可能已经失效，因此不得假装长期会话仍然成立；应清理运行时凭据并进入 `reauthenticationRequired`。Provider 未返回新 Refresh Token 时继续使用当前 Keychain 值。

### 10.5 Tombstone-first 本地退出

退出仍是纯本地动作，不调用 Revocation/End Session Endpoint，不打开浏览器。顺序固定为：

```text
立即清空 Rust 内存 Token 和 Session
        ↓
删除当前用户头像缓存
        ↓
把 Refresh Token 条目覆盖为 signed_out Tombstone 并复读验证
        ↓
尽力删除 Refresh Token / Session Metadata
        ↓
把 Pending Login 条目覆盖为 consumed Tombstone 并复读验证
        ↓
尽力删除 Pending Login
        ↓
验证不存在 active Auth Credential
        ↓
发布 anonymous
```

Tombstone 使删除操作失败时留下的记录也不能被恢复为有效 Session 或登录交易。Tombstone 写入失败时，adapter 会尝试物理删除并复读确认条目不存在；若两种路径都无法证明 active 凭据已失效，当前进程仍立即匿名并禁用认证，同时返回 `AUTH_PERSISTENT_LOGOUT_NOT_GUARANTEED`。本地工作台继续使用。

### 10.6 平台失败与公开错误

Keychain 不存在条目是正常匿名；Keychain 被锁定、用户拒绝访问、Linux Secret Service/DBus 不存在或平台存储发生 I/O 错误，不得伪装成“无会话”，也不得启动登录覆盖未知凭据。认证和 Cloud 同步分别降级为暂不可用，本地工作台继续启动。当前公开错误码：

```text
AUTH_SECURE_STORAGE_UNAVAILABLE
AUTH_SECURE_STORAGE_ACCESS_DENIED
AUTH_SECURE_STORAGE_CORRUPTED
AUTH_SECURE_STORAGE_ITEM_TOO_LARGE
AUTH_PERSISTENT_LOGOUT_NOT_GUARANTEED
```

Windows 使用 Credential Manager；macOS 正式包必须保持稳定 Bundle Identifier 与签名身份；Linux 只使用 Secret Service 兼容实现，不以 `~/.config` 或应用数据文件回退。系统 Keychain 调用可能阻塞，平台 adapter 必须在阻塞线程执行，不能阻塞 Tauri 主线程。

## 11. 会话恢复、刷新与退出

启动后 AuthManager 在阻塞线程读取系统 Keychain：无会话进入 `anonymous`；存在完整且绑定关系一致的会话则使用 Refresh Token 恢复短期 Access Token。临时网络失败保留最后一次已验证用户和 Keychain Refresh Token，状态仍允许退出，并显示账号服务暂不可用；Refresh 被 Provider 拒绝、身份校验失败、Provider fingerprint 变化或 Keychain 记录损坏时清除持久会话并进入 `reauthenticationRequired`。Refresh Token Rotation 先保存并复读新 Refresh Token，成功后才更新内存 Access Token；保存失败会清空运行时凭据、尽力清除 Keychain Session，并要求重新登录。

“登录一次、长期使用”依赖 Provider 的 Grant/Refresh Token 策略，不是客户端可以无限延长的承诺。Logto 当前官方文档说明 Native App 的 Refresh Token TTL 默认 14 天、最大 180 天，请求刷新可以续期到配置值；但应用 Grant 默认 TTL 也是 180 天，并作为当前 Refresh Token chain 的绝对上限。应在自维护实例中启用 Rotation，并按产品预期设置 Native App Refresh Token TTL；达到 Provider 的 Grant 上限、管理员撤销或用户安全状态变化后，NexusPilot 会正常要求重新登录，而不会影响本地工作台。

退出是纯本地操作：立即清空内存 Token、Session 与 Pending Login并删除当前用户头像缓存；随后把 Refresh Token 覆盖为 `signedOut` Tombstone、把 Pending Login 覆盖为 `consumed` Tombstone并复读验证，再尽力删除 Refresh Token、Session Metadata 与 Pending Login 条目。物理删除失败时，已验证的 Tombstone 仍使记录不可恢复；Tombstone 写入失败时尝试删除并复读确认条目不存在。只有既无法持久 Tombstone、又无法删除并确认旧凭据不存在时，才返回 `AUTH_PERSISTENT_LOGOUT_NOT_GUARANTEED`、保持当前进程匿名并禁用认证。本地工作台不受影响。退出不调用 Revocation Endpoint、不调用 End Session Endpoint、不打开系统浏览器，也不依赖网络或 Provider 可用性。Provider 浏览器 SSO Cookie 和服务端 Grant 可能继续存在，但 NexusPilot 不再持有有效的本地 Refresh Token，重启后保持匿名；未来若产品重新需要“退出所有设备/退出浏览器 SSO”，必须作为独立、显式的网络动作重新设计。

退出、换账号、Provider 更换或 Grant 失效均不删除或切换 SQLite、连接配置、AI Runtime 数据与其他本地资产。

## 12. Auth IPC 与标题栏账号卡片

认证 IPC 使用独立的窄口封装，不进入数据库 Engine 的 `apiInvoke()`/runtime health/toast 体系：

```text
get_auth_snapshot
get_auth_avatar
start_auth_sign_in
cancel_auth_sign_in
retry_auth_session
sign_out_auth_session

event: auth-session-changed
```

`AuthSessionSnapshot` 只包含 phase、operation、Provider 可用性、Provider 摘要、最小公开用户资料及可选 `avatarRevision`、是否存在可用 Access Token、过期/恢复时间和 `AuthPublicError`。事件 payload 与 command 返回结构完全相同。`get_auth_avatar(revision)` 是独立只读二进制窄口：只在 revision 与当前已登录用户和本地文件内容同时匹配时返回 PNG，否则返回空数据；React 对预期的 `ArrayBuffer` 和异常桥接形态统一执行 `Uint8Array` 复制。React 启动时先订阅事件再读取 Snapshot，读取期间若收到事件则保留较新状态；Zustand Auth Store 不持久化，也不解析 JWT。

账号入口位于标题栏主题按钮与窗口控制之间，不进入 NavigationRail，也没有 `/login` 或 callback React Route。Hover 只显示 Tooltip，点击/键盘打开 Popover。卡片应明确这是 NIEEX Account，而不是 NexusPilot 专属账号；未登录明确说明本地工作台始终无需登录，并以醒目但无交互入口的提示预告“登录后可使用 NexusPilot Cloud 同步资产，敬请期待”。已登录优先展示 Rust 本地净化头像，没有头像或任何头像处理失败时展示本地首字母，并展示昵称、稳定 Handle、邮箱、账户中心外链和退出；“账户中心”通过系统默认浏览器固定打开 `https://auth.nieex.com/account/profile`。WebView 不加载远程头像。该预告不得宣称 Cloud 已可用，也不得提供同步、云备份或团队功能入口。

## 13. Windows 正式安装包手动验证

该验证由用户在正式提交前手动执行。全过程只需要主动拉起窗口两次：一次冷启动、一次热启动；不要反复触发测试 URI。

### 13.1 构建与安装

1. 确认没有运行 Debug 或正式 NexusPilot。
2. 在仓库根目录执行：

   ```powershell
   bun run tauri build
   ```

3. 使用实际准备分发的安装器。NSIS 默认位置类似：

   ```text
   src-tauri/target/release/bundle/nsis/NexusPilot_0.8.0_x64-setup.exe
   ```

4. 完成安装并记录实际安装目录。

### 13.2 检查正式 Scheme

关闭 NexusPilot，然后在 PowerShell 中分别检查：

```powershell
reg query HKCU\Software\Classes\dev.nexuspilot /s /reg:64
reg query HKLM\Software\Classes\dev.nexuspilot /s /reg:64
```

验收标准：

- 至少在与安装模式一致的位置存在一条关联；
- `shell\open\command` 指向正式安装目录中的 `NexusPilot.exe`；
- 命令包含 `"%1"`；
- 不得指向仓库的 `target\debug\NexusPilot.exe`；
- 不得同时存在互相冲突的 HKCU/HKLM 关联。

### 13.3 冷启动验证（第一次窗口拉起）

确保任务管理器中没有 NexusPilot 进程，然后只执行一次：

```powershell
Start-Process 'dev.nexuspilot://auth/signed-out?manual_test=cold'
```

验收标准：

- NexusPilot 被打开；
- 只存在一个 NexusPilot 主进程；
- 本地工作台能够正常加载；
- 不出现包含原始 URL 的错误提示。

### 13.4 热启动验证（第二次窗口拉起）

保持 NexusPilot 已运行，先记录它的 PID，然后只执行一次：

```powershell
Start-Process 'dev.nexuspilot://auth/signed-out?manual_test=hot'
```

验收标准：

- 已有窗口恢复并聚焦；
- 原 PID 保持不变；
- 短暂第二实例自动退出；
- 最终仍只有一个 NexusPilot 主进程；
- 本地工作台状态不丢失。

### 13.5 卸载清理

1. 关闭 NexusPilot；
2. 从 Windows“已安装的应用”卸载本次测试版本；
3. 再次执行两条 `reg query`；
4. 两处均应返回“找不到指定的注册表项或值”；
5. 不需要在卸载后再次打开 Scheme，以免触发 Windows 选择应用提示。

如果实际发布 MSI/WiX，还应对 MSI 单独重复 12.1、12.2 和 12.5；只发布 NSIS 时无需为未分发的安装器增加验收负担。

### 13.6 回报格式

完成后向实现者回报：

```text
安装器：NSIS / MSI
安装模式：当前用户 / 全部用户
注册位置：HKCU / HKLM
open command：<可隐藏用户名，但保留安装目录结构>
冷启动：通过 / 失败
热启动单实例：通过 / 失败
卸载清理：通过 / 失败
异常现象：无 / 描述
```

## 14. 真实 Logto 登录手工验收

自动化测试不会主动打开 NexusPilot、系统浏览器或测试 URI。完成正式安装后，按以下顺序只执行一次每个动作：

1. 在 Logto Console 确认应用类型为第一方 Native App / Public Client，Application ID 与嵌入式 Provider 配置一致，精确允许 `dev.nexuspilot://auth/callback`，启用 Refresh Token Rotation，并将 Native App Refresh Token TTL 设置为符合“长期登录”预期的值后保存配置。确认全局 API Resource `https://api.nexuspilot.dev` 定义 `cloud:access`，测试用户通过全局 User Role 获得该 Permission。第一方应用不要求配置 Third-party App 的“授予用户数据权限”allowlist。`dev.nexuspilot://auth/signed-out` 可为兼容旧配置保留，但当前本地退出不会使用它。当前官方文档的最大值为 180 天；实际能力以自维护 Logto 版本为准。
2. 正常启动正式安装版 NexusPilot。打开标题栏账号卡片，确认未登录文案明确“本地工作台始终无需登录”。
3. 点击“立即登录”。预期只打开一次系统浏览器；在 Logto 完成登录或注册。Provider 回调后 NexusPilot 可能恢复并聚焦一次，这是预期的热启动 single-instance 行为。
4. 确认账号卡片展示昵称、`@handle` 和邮箱；如果 Logto 用户设置了有效头像，应在短暂异步加载后显示头像，没有设置或头像不可用时应稳定显示首字母且不出现认证错误。本地数据库工作台状态不丢失。日志、Toast、开发者工具与网络面板中不得出现 Authorization Code、Token、state、nonce、完整 Callback URL 或 Provider 原始 `picture` URL；WebView 不应直接请求头像远程域名。
5. 打开 Windows“凭据管理器 → Windows 凭据 → 常规凭据”，确认正式安装版在 `NexusPilot.Auth.v1` 命名空间保存了 `refresh-token` 与 `session-metadata`；已完成的 `pending-login` 应不存在或为不含 state/nonce/PKCE 的 consumed Tombstone。不得出现 Access Token、ID Token、Authorization Code、邮箱或昵称组成的条目名称。不要在验收记录中复制任何凭据内容。
6. 关闭并重新启动 NexusPilot。预期不打开浏览器，账号通过 Refresh Token 自动恢复；头像应使用或更新本地缓存，这验证“登录一次、长期使用”的基础体验。
7. 可选离线验证：关闭应用、断网后重新启动。账号卡片应保留最后身份和已缓存头像，并提示账号服务暂不可用；头像缓存缺失时只显示首字母。连接本地数据库、设置和其他本机能力仍可使用。恢复网络后点击“重试恢复”。
8. 点击“退出登录”。账号卡片必须立即回到匿名，不得打开系统浏览器、不得发送 Revocation/End Session 请求、不得触发 Deep Link 或额外聚焦窗口；断网时行为必须完全一致。
9. 再次检查凭据管理器：上述 active Refresh Token 必须不存在；若平台删除未完成，只允许留下不含 Token 的 `signedOut` Tombstone。随后关闭并启动应用，确认保持匿名，且本地数据库连接与工作区数据仍存在。

验收回报建议包含：登录、启动恢复、离线隔离、重试恢复、本地退出、重启后匿名、窗口/浏览器额外拉起次数和任何异常。

## 15. 当前验收边界

代码与自动化验证已经覆盖 Provider 配置、Discovery 能力过滤、回调解析、Pending Login、state、Provider fingerprint、Refresh Rotation、临时离线、Refresh 拒绝、Keychain 分条 Schema 与容量边界、generation/identity 绑定、写后复读、损坏记录失败关闭、Rotation 持久化失败、Tombstone-first 退出、Tombstone 写失败时的删除复读兜底、物理删除失败后凭据仍不可恢复、Keychain 不可用时禁止打开浏览器、纯本地退出且零 Provider/Browser 调用、标准 `picture` 映射、头像 URL/地址过滤、格式/尺寸净化、身份/revision 缓存绑定、Tauri 二进制 payload 归一化、头像失败隔离和退出清理，以及 Cloud Token 当前复用、并发单飞刷新与退出失效。当前自动化测试不会读写真实用户 Keychain，而是通过与生产 `SystemAuthCredentialStore` 相同的事务逻辑注入内存后端；Windows Credential Manager、macOS Keychain 与 Linux Secret Service 仍需要相应平台的发布包手工验收。2026-07-18 用户已完成第 13、14 节所覆盖的 Windows NSIS、真实 Logto 与真实头像基础闭环验收，该验收发生在 Keychain cutover 之前；2026-08-05 用户进一步确认 Windows 开发环境在 Keychain cutover 后能够完成真实 NIEEX Account 登录，并使用旧 Third-party App 完成真实 Cloud Bootstrap：连续两次调用均成功、返回同一内部账户，账户为 `active`、初始订阅为 `free/active`、连接同步为 `not_entitled`、`policyVersion = 1`，且验收未输出 JWT 或外部身份。同日嵌入式 Provider 已切换到新的第一方 Native App，用户确认新应用真实登录正常，第一方 Client cutover 可以收尾并进入下一阶段；尚未据此宣称迁移前后 `account.id` 对比、正式安装包 Keychain 条目、重启恢复、本地退出和重启后匿名已经复验，这些项目保留为后续真实联调与发布回归项。受 Fake-IP DNS 影响时头像按设计降级，切换到可提供公网解析的 VPN 后验证显示正常。账号卡片可以展示 NexusPilot Cloud 的“即将开放”预告；当前只新增 Rust-only Bootstrap 与脱敏 Cloud IPC，不代表资产同步、团队、订阅购买、移动端或 React Access Token IPC 已可用。

配置和平台行为依据 [Tauri v2 Deep Linking 官方文档](https://v2.tauri.app/zh-cn/plugin/deep-linking/)；当前第一方 Logto Native/Public Client、Rotation 与 TTL 依据 [Logto Application data structure](https://docs.logto.io/integrate-logto/application-data-structure)，旧应用迁移历史中的第三方 scope allowlist 与 Consent 依据 [Logto Third-party Application Permission Management](https://docs.logto.io/integrate-logto/third-party-applications/permission-management)，用户名到 `preferred_username` 的回退及 `avatar` 到标准 `picture` Claim 的映射依据 [Logto User data structure](https://docs.logto.io/user-management/user-data)；Provider 运行时行为以标准 OIDC Discovery 和真实 Logto 元数据为准。
