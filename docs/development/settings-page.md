# 设置页设计与开发约束

本文档描述 NexusPilot 设置页的统一结构、组件边界和后续开发约束。它的目标是让设置页在弹窗与独立路由两个入口下保持一致，并为后续智能体开发提供明确的复用规则。

## 1. 页面边界

当前设置系统有两个入口：

- `SettingsDialog`：工作台内的设置弹窗。
- `SettingsPage`：`/settings` 路由页面。

这两个入口都只是壳层，不应承载具体设置项的布局细节。真正的设置内容应由分组面板提供。

`SettingsDialog` 与 `/settings` 路由当前复用同一个 `SettingsWorkspace` 共用壳，避免弹窗与页面出现两套不同的侧边导航和面板切换逻辑。

## 2. 标准内容分组

`src/features/settings/components/settings-section.tsx` 中的 `SettingsSection` 是设置页的标准内容分组组件。

它的职责是：

- 提供统一的小节标题与说明文字。
- 提供一致的内容缩进和垂直节奏。
- 作为设置面板内部的“二级区块”标准壳。

使用约束：

- 设置面板内需要分块时，应优先使用 `SettingsSection`。
- 不要在面板里手写一套新的 section heading + content block 结构。
- 不要用 Card 代替设置项分组，除非该分组本身就是一个独立工具面板。

## 3. 面板组织

`settings-sections.ts` 定义设置页左侧导航与右侧面板的映射。每个面板应做到：

- 一个面板负责一个稳定设置域。
- 面板内再使用 `SettingsSection` 组织具体字段。
- 面板本身不负责页面壳和导航。

当前新增设置域时的推荐步骤：

1. 在 `types/settings.ts` 增加设置契约。
2. 在 `config/app-settings.ts` 提供默认值。
3. 在 `store/slices/settings-slice.ts` 增加读写 action。
4. 在 `settings-sections.ts` 注册新面板。
5. 在新面板中使用 `SettingsSection` 组织字段。

当前已落地的编辑器面板为 `EditorSettingsPanel`，它示范了设置页面板如何直接读写 `useSettingsStore().editor`，并通过 `SettingsSection` + `FieldGroup` 组织字段。

Runtime-owned 设置是上述本地流程的明确例外。当前“AI 偏好设置”通过 AI Runtime 的 `GET /v1/settings` 与唯一的 `PUT /v1/settings` 读取和完整替换设置快照，使用 TanStack Query 缓存，不写入 `types/settings.ts`、`useSettingsStore` 或 Tauri Store。原因是工具权限与网络范围由 sidecar 在新 Run 创建时冻结并执行，Frontend 不能成为第二权威来源。新增 Runtime-owned 设置项时，扩展同一 settings snapshot、默认值和表单；不要为单个字段新增 endpoint。只有 Frontend/Tauri 本地应用偏好才沿用步骤 1-3。

Cloud-owned 状态是另一类明确例外。“账户与 Cloud → Cloud 同步”是同步管理的设置面板，但订阅、权益、配额、生命周期、设备和 Cloud 同步初始化状态均由 Cloud 返回，不写入 `types/settings.ts`、`useSettingsStore` 或 Tauri Store。账户卡片展示当前订阅、有效期、设备数量和存储用量，并通过低强调按钮导航到该面板；设备数量以文本展示，存储用量可以使用进度条。Cloud 设置页使用一个统一的 Cloud 账户信息卡片承载订阅和用量；同步区域直接展示状态与操作，不再为用量或“端到端加密同步已启用”额外嵌套卡片。Cloud 设置页同时展示 Cloud 同步状态和本地同步密钥状态：只有 Cloud 已初始化且本地 SyncKeyStore 状态为 ready 时，才显示“端到端加密同步已启用”；本地 Keychain 不可用或损坏时不能仅凭 Cloud 状态显示为可同步。Cloud 设置页直接渲染页面结构：有展示缓存时先显示缓存，没有缓存时在账户和同步内容处使用 Skeleton，不使用全局加载遮罩。刷新反馈通过账户卡片的 Cloud 状态槽、具体操作按钮和局部内容状态表达，不在 Cloud 概览或同步与安全页面额外展示“更新时间”。首次刷新超过界面等待阈值后，停止 Skeleton/Spinner 并显示可重试的中性提示，不把界面等待超时伪造成 Cloud 业务错误；真实请求失败仍显示脱敏错误。Cloud 投影在进程内由设置页和账户卡片共享，账户卡片每次打开会强制刷新；Cloud 概览和同步与安全页面重复进入时先展示已有快照，并对最近 10 秒内已完成的共享刷新进行短时去重，超过后再联网刷新。退出或切换账号时清空。待授权设备、待补充路径和待处理冲突等辅助数据只在本次 Cloud 投影确认已连接后读取，刷新期间保留已有列表，旧账户或旧代次的迟到响应不得覆盖当前页面。缓存仅用于展示，不能驱动任何业务授权。未初始化时使用“启用加密同步”按钮打开独立说明 Dialog，不使用 Switch，也不能因打开页面或 Dialog 自动生成密钥、注册设备或上传数据。

Cloud 账户状态刷新不会因为状态栏渲染、普通页面重绘或窗口前后台切换而自动发生；Cloud 同步由 Rust 调度器独立响应应用启动、认证成功、前台恢复、本地连接/文件夹变更、手工同步、恢复同步和可重试失败。具体触发矩阵以 [Cloud Desktop 状态投影](../architecture/cloud-desktop-state.md#51-cloud-账户状态的联网刷新时机) 为准。

Cloud 连接摘要还会以只读状态项显示在工作台底部状态栏；它只反映 Rust Cloud 投影的连接阶段，不承担订阅、权益或同步授权判断，也不提供 Cloud 操作入口。

## 4. 设计原则

- 设置页以“稳定、可扫描、可持续扩展”为主，不追求复杂交互。
- 同类字段应保持同样的控件形态。
- 面板层只做设置项编排，不做业务逻辑下沉。
- Frontend/Tauri 本地设置尽量通过 `useSettingsStore` 即时生效；Runtime-owned 设置必须通过对应 sidecar API 读写，避免出现两个权威来源。
- Cloud-owned 状态必须通过 Rust Cloud Client 和窄 IPC 读取/操作；Frontend 不直接访问 Cloud，也不成为订阅、权益或同步状态的第二权威来源。
- 新增设置项时要同步更新文档、默认值和 store 契约，避免出现“UI 已有但设置不可持久化”的断层。

## 5. 编辑器设置的专门约束

编辑器设置属于设置页中的一个稳定分组，应继续遵守通用编辑器文档中的规则：

- 只保存高频用户偏好，不保存完整 Monaco options。
- 通过 preset 表达场景体验。
- 通过 `SettingsSection` 组织内部字段，例如字体、字号、行高、换行、minimap、行号等。

## 6. 智能体约束

后续智能体在修改设置页时应遵守：

- 先检查 `SettingsSection` 是否可复用，再决定是否需要新增更底层的设置分组组件。
- 不要直接复制现有设置面板的布局结构。
- 如果新增设置域，必须同步更新本文件和相关架构文档。
- 如果修改了 `SettingsSection` 的语义或样式，需评估是否影响所有设置面板。
