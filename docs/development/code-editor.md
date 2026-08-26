# 通用代码编辑器设计与开发约束

本文档描述 NexusPilot 通用代码编辑器子系统的设计原则、当前实现、使用规范与后续智能体开发约束。它不是一次性的使用说明，而是编辑器能力持续演进时的团队共识文档。

后续任何涉及 SQL 编辑器、Redis value 编辑、JSON/XML/日志查看、大文本字段查看、脚本编辑等场景的开发，都应先阅读并遵守本文档。

## 1. 设计目标

通用代码编辑器的目标是提供一个可长期复用的结构化文本查看与编辑基础设施，而不是为某个业务视图临时封装 Monaco。

它需要服务的长期场景包括：

- SQL 查询编辑器。
- Redis string / JSON / XML 查看与编辑。
- 关系型数据库大文本字段查看与编辑。
- MongoDB / JSON 文档查看与编辑。
- DDL、Explain、日志、脚本、AI 生成内容预览。

核心目标：

- 业务模块不直接依赖 Monaco 细节。
- 编辑器体验在全应用内一致。
- 用户偏好集中持久化，后续设置页可接入。
- 场景差异通过项目级 preset 表达，而不是散落大量 Monaco options。
- 文档、类型、默认行为共同约束智能体后续开发。

## 2. 当前实现

通用编辑器入口位于 `src/components/editor/`：

- `CodeEditor`：编辑与只读都可使用的底层封装。
- `CodeEditorDialog`：面向 JSON、长文本、SQL 片段、脚本等代码类内容的可复用弹窗编辑容器，内部复用 `CodeEditor`。
- `CodeViewer`：只读查看语义封装，内部复用 `CodeEditor`。
- `CodeEditorLanguage`：项目允许的语言标识集合。
- `CodeEditorPreset`：项目级场景预设集合。
- `useEditorTheme`：将应用主题映射到 Monaco 内建主题。
- `editor-settings.ts`：集中处理语言映射、高度计算、preset 与 options 合并。

外部业务代码只应从 `@/components/editor` 导入公共入口。除编辑器子系统内部实现外，禁止直接引入 `@monaco-editor/react`。

## 3. 状态与设置契约

编辑器用户偏好存放在 `AppSettings.editor`，通过现有 `useSettingsStore` 管理，并由 Zustand persist 接入 Tauri Store 本地持久化。

当前设置字段：

- `fontFamily`
- `fontSize`
- `lineHeight`
- `tabSize`
- `wordWrap`
- `minimapEnabled`
- `lineNumbers`
- `renderWhitespace`

设计约束：

- 只把稳定、高频、适合设置页暴露的用户偏好放入 `AppSettings.editor`。
- 不把 Monaco options 原样持久化到 settings。
- 后续设置页面必须通过 `useSettingsStore` 的 editor setter 修改这些字段。
- 业务组件不得自行持久化编辑器偏好。
- `fontFamily` 默认留空，表示使用 Monaco 自带默认字体；只有用户显式填写时才把该值传给编辑器。

Zustand 是这里的权威状态来源。TanStack Query 只用于服务端数据缓存，不用于编辑器本地偏好。

## 4. Options 治理模型

Monaco options 数量很多，项目不全量托管。编辑器配置按三层治理：

1. 全局用户偏好：字体、字号、行高、Tab、换行、行号、minimap、空白字符等。
2. 项目场景预设：由 `preset` 表达 SQL 编辑器、紧凑预览、大文本只读、JSON 文档等体验策略。
3. 局部逃生口：业务组件可通过 `options` 做少量场景覆盖。

合并优先级：

```txt
项目基础默认值 < preset < options
```

其中全局用户偏好会参与项目基础默认值，业务 `options` 不应覆盖用户偏好，除非该业务场景确实需要强约束并能解释原因。

当前预设：

| preset | 用途 |
| --- | --- |
| `default` | 默认编辑体验，适合普通文本编辑 |
| `sqlEditor` | SQL 主编辑器，保留 folding、hover、链接与 sticky scroll |
| `compactPreview` | 短内容只读预览，关闭 folding、hover、glyph、链接等干扰项 |
| `largeReadonly` | 大文本只读查看，固定高度与内部滚动优先 |
| `jsonDocument` | JSON 文档查看/编辑，保留折叠与括号高亮 |

新增 preset 时，需要同步更新：

- `CodeEditorPreset` 类型。
- `getCodeEditorPresetOptions()`。
- 本文档的 preset 表。

## 4.1 SQL 编辑器接入约束

SQL 查询编辑器一阶段目标见 [sql-editor.md](./sql-editor.md)。接入 Monaco 时必须继续走项目级封装：

```tsx
<CodeEditor
    value={sqlText}
    language="sql"
    preset="sqlEditor"
    height="100%"
    heightMode="fixed"
    onChange={setSqlText}
/>
```

SQL 编辑器业务组件不得直接导入 `@monaco-editor/react`，不得绕过 `CodeEditor` 自行维护 Monaco options。SQL 文本草稿、保存快照、执行上下文和执行结果状态应保存在 SQL editor tab runtime state 中，而不是依赖 Monaco 实例生命周期。

由于 Workbench 内容区使用 React 19 `Activity`，SQL 编辑器在非 active tab 下必须卸载 `CodeEditor` 或渲染同尺寸占位，避免 hidden 状态恢复时复用已 disposed 的 Monaco service。

一阶段不显示 SQL 格式化按钮；如果后续加入格式化，应先确认 SQL 方言、引入 formatter 的范围、失败回退策略，并同步更新 [sql-editor.md](./sql-editor.md)。

## 5. 高度与滚动设计

`heightMode` 用于明确滚动策略：

- `fixed`：用于 SQL 编辑器、大文本、大 value，编辑器内部滚动，性能更稳。
- `auto`：用于短 JSON、XML、日志片段等只读预览，编辑器按行数撑开并限制最大高度。

默认建议：

- 主编辑器使用 `fixed`。
- 轻量预览使用 `auto`。
- 内容规模不可控时优先选择 `fixed`。

不要为了复用页面外层 ScrollArea 而让大内容编辑器无限撑高。Monaco 对大内容的性能优势来自内部虚拟滚动。

## 6. 主题策略

编辑器主题跟随应用主题：

- 浅色应用主题使用 Monaco `light`。
- 深色应用主题使用 Monaco `vs-dark`。
- 系统主题监听 `prefers-color-scheme`。

当前阶段只使用 Monaco 内建主题。未来如需自定义 token theme，应在编辑器子系统中集中定义，并同步记录到本文档。

## 7. 使用规范

编辑态：

```tsx
<CodeEditor
    value={sql}
    language="sql"
    preset="sqlEditor"
    height="100%"
    heightMode="fixed"
    onChange={setSql}
/>
```

只读查看：

```tsx
<CodeViewer
    value={formattedJson}
    language="json"
    preset="jsonDocument"
    heightMode="auto"
/>
```

弹窗编辑：

```tsx
<CodeEditorDialog
    open={open}
    onOpenChange={setOpen}
    title="JSON"
    description="payload"
    value={draft}
    language="json"
    preset="jsonDocument"
    validate={(value) => {
        try {
            JSON.parse(value);
            return null;
        } catch {
            return "JSON 格式无效";
        }
    }}
    toolbarActions={({ draftValue, setDraftValue }) => (
        <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDraftValue(JSON.stringify(JSON.parse(draftValue), null, 2))}
        >
            格式化
        </Button>
    )}
    onApply={setDraft}
/>
```

`CodeEditorDialog` 默认禁止点击遮罩和 `Esc` 关闭，避免大文本或代码编辑过程中误关闭。右上角关闭按钮在未编辑时直接关闭；如果当前草稿处于 Dirty 状态，会先弹出“放弃未应用的修改”确认框，只有确认放弃后才关闭并丢弃本次草稿。弹窗内部维护临时草稿，并显示“已编辑 / 未编辑”、行数和字符数；只有点击“应用”才把草稿交给业务方。

弹窗布局面向代码和长文本编辑优化：移动或窄屏下接近全宽，桌面宽屏下使用更宽的响应式尺寸，避免 JSON、SQL、日志等内容被压缩在窄列中。

业务接入原则：

- 新业务场景先判断是编辑态还是只读态，分别使用 `CodeEditor` 或 `CodeViewer`。
- 新语言需要先扩展 `CodeEditorLanguage` 与语言映射。
- 新默认配置应从全局设置契约或 preset 出发，避免局部组件形成孤岛。
- `options` 只用于少量覆盖，不允许复制完整 Monaco 配置。
- 业务组件不得直接依赖 Monaco 实例完成常规渲染。
- 如果编辑器所在 tab 使用 React 19 `Activity mode="hidden"` 保活隐藏内容，不要在 hidden 状态继续挂载 Monaco。调用方应传递显式可见性状态，在 hidden 时卸载 `CodeEditor/CodeViewer/CodeEditorDialog` 或渲染同尺寸占位，等 tab 回到 visible 后重新挂载编辑器；业务草稿必须保存在 tab runtime state、弹窗自身 React 状态或其他 React 状态中，而不是依赖 Monaco 实例保留。

原因：`Activity hidden` 会清理子树 effects，但保留组件状态；`@monaco-editor/react`/Monaco 在这种生命周期下可能复用到已经 disposed 的内部 service，切回 tab 时触发 `InstantiationService has been disposed`。Redis KeyValueView 已采用 `isActive` 传递 + hidden 占位的模式规避该问题，后续 SQL、JSON/XML、大文本编辑场景应复用这个策略。

## 8. 智能体开发约束

智能体后续修改编辑器相关能力时必须遵守：

- 先检查本文档，再修改编辑器相关代码。
- 不在业务组件中直接导入 `@monaco-editor/react`。
- 不把 Monaco options 全量加入 settings。
- 修改 `AppSettings.editor` 时同步更新默认值、store merge 逻辑、本文档。
- 新增 preset、language、主题策略时同步更新类型、实现、文档。
- Redis、SQL、JSON 等业务场景如果需要编辑器差异，应优先通过 preset 表达。
- 在 `Activity hidden`、折叠面板、虚拟化列表或其他会反复隐藏/恢复 DOM 的容器中接入编辑器时，必须先确认生命周期策略；默认在不可见时卸载 `CodeEditor/CodeViewer/CodeEditorDialog` 或渲染同尺寸占位，并把草稿状态放在业务 runtime state、弹窗自身 React 状态或其他 React 状态中，而不是依赖 Monaco 实例保留。
- 文档与实现不一致时，应在同一批变更中修正文档，不能让本文档失效。

本文档是智能体约束文档。随着编辑器能力扩展，必须持续增补设计决策、使用边界和已知限制。
