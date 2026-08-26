# ADR 0003：Cloud 同步密码协议与显式启用流程

## 状态

Accepted

## 日期

2026-08-06

## 背景

NexusPilot Cloud V1 需要在 Cloud、NIEEX Account 和网络传输层均无法读取用户连接资产的前提下，完成首台设备初始化、后续设备授权和恢复。登录 NIEEX Account 只能证明用户有权访问对应 Cloud Account，不能替代端到端加密密钥。

同步同时是一个明确的用户选择。应用不能因为用户登录、打开账户卡片或读取 Cloud 状态就自动生成密钥、注册设备或上传数据。用户需要先理解恢复责任、确认设备名称并保存 Recovery Key，才能正式启用。

订阅模型也不应与单一功能绑定。连接同步是 V1 首个使用 Cloud entitlement 的能力，未来还可能增加 AI 同步、设置同步或其他 Cloud 能力；产品文案和 API 消费方不能把 Plus 等价为“连接同步套餐”。

## 决策

### 1. 显式启用与信息架构

- 账户卡片只展示概括状态和快捷入口，不承载完整同步配置。
- “设置 → 账户与 Cloud → Cloud 同步”是同步管理的权威界面；它读取 Cloud 权威投影，不写入本地设置 Store。
- 未初始化账户显示“启用加密同步”按钮，不使用容易被误解为即时开关的 Switch。
- 点击按钮只打开独立 Dialog 说明向导，不生成密钥、不注册设备、不写 Cloud。
- 向导依次完成：说明端到端加密与恢复责任、确认设备名称、由用户点击“生成恢复密钥”、保存 Recovery Key、最终确认启用。
- Dialog 通过只读 `get_sync_setup_context` 取得建议设备名；Rust 侧复用已接入的 `tauri-plugin-os` 读取真实短主机名，该命令不生成任何密钥。
- 用户确认设备名并点击“生成恢复密钥”后，`begin_sync_setup(deviceName)` 才在 Rust 进程内存创建一次性 setup session，并把 `{ setupId, recoveryKey }` 通过窄 IPC 返回一次；此时不写 Keychain、不注册设备、不写 Cloud。
- 只有用户完成 Recovery Key 保存确认并点击最终确认后，Rust 才把该 setup session 的密钥材料写入 initialization-specific Keychain pending 项并提交首设备初始化；Cloud 确认成功后再提升为当前账户的正式设备密钥包。
- 登录后允许只读拉取 Cloud 同步状态；禁止自动初始化、自动生成新 AMK 或自动开启上传。

### 2. 设备名称

- 首设备默认使用操作系统的真实短主机名，帮助用户区分设备；避免优先使用 FQDN。
- 上传前必须展示并允许用户编辑。设备名是 Cloud 可见的非秘密元数据，不参与设备身份、签名、密钥派生或授权判断。
- 设备身份由 Cloud device ID 与设备公钥确定，重名合法。
- 设备名去除首尾空白，拒绝控制字符和双向文本控制字符，限制为 64 个 Unicode 字符且 UTF-8 不超过 256 字节。
- 不自动附加登录用户名、Home 路径、MAC、硬件序列号、IP 或其他硬件指纹。
- 注册时保存名称快照；主机之后改名不会静默改写 Cloud 记录，后续由用户显式重命名设备。

### 3. 密码套件与信封

- Account Master Key（AMK）为 CSPRNG 生成的 256-bit 随机值。
- 每台设备分别生成 X25519 加密密钥对和 Ed25519 签名密钥对；两个用途不得共用同一密钥。
- AMK 设备信封使用 RFC 9180 HPKE：X25519 + HKDF-SHA-256 + ChaCha20-Poly1305。
- Recovery Key 为 CSPRNG 生成的 256-bit 随机值，使用带校验的 Bech32m 文本编码和 `nprk` HRP。
- Recovery Key 本身已具有足够熵，恢复 KEK 使用 HKDF-SHA-256 加随机 salt 派生；未来二级密码必须使用独立的 Argon2id 密码信封，不能复用 Recovery Key KDF。
- AMK 恢复信封和未来资产密文使用 XChaCha20-Poly1305。
- 所有格式均带显式 suite/format version，并使用 associated data 绑定用途、版本、Cloud Account ID 和 key generation。设备信封额外绑定目标 Device ID 与加密公钥指纹；恢复信封不绑定首台设备，使 Recovery Key 能在原设备不可用时独立恢复同一 AMK。任何适用上下文不匹配都必须 fail closed。
- 密码实现使用经过审计的成熟库，并以固定测试向量、篡改测试和跨版本兼容测试约束；不得自行实现密码原语。

### 4. SyncKeyStore

- 同步密钥使用独立于认证凭据的系统 Keychain service：Release 为 `NexusPilot.Sync.v1`，Debug 为 `NexusPilot.Sync.dev.v1`。
- Keychain account 使用 `device-key-bundle:<cloud-account-id>`，值为版本化、原子写入并回读验证的设备密钥包。
- 密钥包至少包含 Cloud Account ID、Device ID、外部身份绑定摘要、key generation、初始化请求 ID、AMK、X25519 私钥和 Ed25519 私钥。
- 损坏或无法解析的同步密钥项不得自动删除，也不得降级写入普通文件；应停止同步并引导恢复或移除设备。
- 普通退出登录清除运行时 AMK，但默认保留已注册设备的 SyncKeyStore 项；下一次只有在成功登录并确认同一 Cloud Account 后才能载入。
- Recovery Key 不写入 Keychain 或应用数据库。用户主动保存的恢复密钥文件是例外，并且只能由 Rust 原生保存动作创建。

### 5. Recovery Key 一次性展示与原生动作

- 完整 Recovery Key 允许通过一个窄 Tauri IPC 进入专用 React Dialog，并在组件局部状态中短暂展示；这是 WebView 密钥禁令的唯一窄例外。作为本地打包的桌面应用，该传递不以先完成全局 CSP 或 capability 改造为前置条件。
- `begin_sync_setup(deviceName)` 返回 `{ setupId, recoveryKey }`。Recovery Key 明文只在该响应中返回一次；React 不得通过其他读取接口再次取得同一次明文。
- Rust 使用 `setupId` 在进程内存中保留对应的待提交密钥材料；setup session 不落盘、有短期超时，并在取消、完成、退出登录、窗口销毁或进程退出时清除和 zeroize。
- Dialog 只使用组件局部内存，关闭、取消、完成、退出登录或窗口销毁时立即清理可达引用；不得进入日志、遥测、错误上报、React 全局 Store 或持久化缓存。
- “复制”调用 `copy_recovery_key(setupId)`，由 Rust 使用系统原生剪贴板完成；React 不调用浏览器 Clipboard API，也不再次传递或接收密钥明文。
- “保存到文件”调用 `save_recovery_key(setupId)`，由 Rust 通过系统保存对话框直接写入用户选择的位置；React 只接收成功/取消/失败状态，不接收文件内容回传。
- 保存文件属于用户主动创建的恢复材料，不是应用凭据存储。文件应包含产品标识、恢复密钥和必要的非秘密说明，不包含 AMK、设备私钥、Token 或账户身份 Claim。
- 用户必须明确勾选或确认“已经保存恢复密钥”，才能进入最终启用步骤；复制动作本身不等同于已安全保存。

### 6. Cloud 原子初始化

- 首设备初始化使用单个幂等、并发安全的 `POST /v1/sync/initialize`，原子创建设备登记、设备公钥、设备 AMK 信封和恢复信封。
- 初始化请求携带稳定 initialization ID。相同请求重试返回同一结果；同一账户的并发首次初始化只有一个 winner，其他请求不得覆盖 AMK。
- `GET /v1/sync/state` 只返回脱敏初始化、当前设备和权益状态。
- `finalize_sync_setup(setupId)` 必须先把材料写入并回读验证 initialization-specific pending 项，再提交 Cloud 初始化；只有 Cloud 以同一 initialization ID 确认成功后才能原子提升为正式设备密钥包。另一个 pending 初始化不得覆盖已有 committed 项。明确的请求拒绝只清理对应 pending 项；若 Cloud 结果未知，则保留本地材料并使用相同 initialization ID 查询/重试，不生成第二个 AMK。
- `cancel_sync_setup(setupId)` 只清理未提交的内存材料。应用在最终确认前退出或崩溃时没有 Keychain/Cloud 初始化副作用，用户下次重新开始。
- 第二台及后续设备不得走首设备初始化；只能通过已有设备授权或 Recovery Key 取得同一个 AMK。
- 重新生成 Recovery Key 采用 compare-and-swap 替换恢复信封；成功后旧 Recovery Key 立即失效，不重新加密已有资产。

### 7. 权益文案与扩展性

- 用户界面使用“Cloud 权益”“账户权益”或具体能力名，不把套餐描述成只提供连接同步。
- 在解释当前限制时可以明确说“当前账户未获得连接同步权益”，但套餐总览、升级入口和账户卡片不得写成“Plus 仅用于连接同步”。
- API 继续按 `features.<featureKey>` 返回具体权限和配额；Desktop 只消费所需 feature，不以 `planCode` 推断能力。
- 未来增加 AI 同步、设置同步等能力时，新增独立 entitlement 和配额维度，不复用或改写 `connectionSync` 的含义。

## 影响

### 正向影响

- 用户不会因登录或浏览设置而意外创建密钥、注册设备或上传数据。
- 真实主机名和可编辑名称降低多设备识别成本，同时不引入硬件指纹。
- 一次性展示、原生复制和原生保存兼顾恢复密钥可用性与桌面端安全边界。
- 版本化信封、独立密钥用途和原子初始化支持后续设备授权、恢复及算法迁移。
- entitlement 和产品文案可以自然扩展到连接同步之外的 Cloud 能力。

### 负向影响

- Recovery Key 进入 WebView 的窄例外扩大了前端攻击面的审查责任，需要保持 IPC、组件状态和日志边界简单且可测试。
- 首次启用比自动开启多几个明确步骤，用户必须承担保存恢复密钥的责任。
- Rust-only 剪贴板和文件保存需要专门的窄 IPC、平台测试和错误处理。
- 原子初始化、幂等恢复和本地/Cloud 不确定结果处理会增加服务端与 Desktop 协议复杂度。

## 不采用的方案

- 登录后自动启用同步：用户未明确同意恢复责任，并可能在无意中上传密文。
- 使用自定义设备名或随机名称作为默认值：不如真实主机名便于用户识别。
- 把 Recovery Key 永远限制在 Rust、完全不在 UI 展示：安全边界更窄，但保存和核对体验明显较差；本 ADR 采用窄 IPC 的一次性展示例外。
- 使用浏览器 Clipboard API 或由 React 生成下载文件：会扩大密钥在 WebView API、Blob、下载和持久化路径中的暴露面。
- 使用短码、邮箱批准或登录 Token 直接派生/传递 AMK：不能满足零知识和端到端加密边界。
- 把 Plus 写死为连接同步权限：阻塞未来 Cloud 产品能力扩展，并把商业套餐与单个技术 feature 错误耦合。

## Verification requirements

The implementation must continue to satisfy:

1. setup session 只存在于 Rust 内存，具有超时、取消、完成、退出和窗口销毁清理测试。
2. Rust-only 剪贴板与保存文件命令只接受 `setupId`，并完成参数、返回值和日志审计。
3. 局部 Dialog 状态不进入全局 Store、持久化缓存、日志、遥测或错误上报。
4. 密码套件固定向量、信封篡改、跨账户/设备/generation 失败测试。
5. Windows Credential Manager 真实环境验证；macOS Keychain 与 Linux Secret Service 在宣称支持前分别验收。

CSP、导航策略和 Tauri capability 收敛属于桌面安全加固的持续要求，不改变 Recovery Key 窄 IPC 的边界。

## 参考

- [Cloud integration boundary](../architecture/cloud-integration.md)
- [Cloud V1 client contract](../contracts/cloud-v1-client-api.md)
- [账户认证架构](../architecture/account-authentication.md)
- [网络请求边界](../architecture/network-boundaries.md)
- [RFC 9180: Hybrid Public Key Encryption](https://www.rfc-editor.org/rfc/rfc9180)
