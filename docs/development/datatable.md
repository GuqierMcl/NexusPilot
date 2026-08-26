# DataTable 组件设计文档

> 最后更新: 2026-07-12

DataTable 是 NexusPilot 的项目级二维数据交互基础设施，定位与 `src/components/editor/` 的通用代码编辑器类似：业务模块不应临时自建表格交互，而应优先通过项目级 DataTable 或业务适配器接入。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 独立复用 | 对外入口为 `src/components/data-table/`，底层实现保留在 `src/components/ui/data-table/` |
| 抽象接口 | 导出 `DataTableColumn`、`DataTableProps` 等类型，供消费者定义行为 |
| 虚拟滚动 | 支持大数据量（万级行）下的流畅渲染 |
| 统一样式 | 基于 Base UI ScrollArea + 项目 ScrollBar，与项目其他滚动区域一致 |
| 列宽调整 | 拖拽表头边缘动态调整列宽，双击重置 |
| 横竖滚动 | 纵向行虚拟化 + 横向列滚动，表头与表体同步 |
| 业务适配 | 底层 DataTable 只负责二维交互；关系型表、Redis 集合等业务语义通过适配器注入 |
| 数据库元数据 | `RelationalDataTable` 展示类型、PK、NOT NULL、UNIQUE、READ ONLY Badge 与 Tooltip |
| 基础编辑交互 | 支持行号栏行选择、单元格选择、右键菜单、单击单元格编辑输入 |
| 类型感知编辑器 | 后端提供列类型归类，前端按类型显示文本输入或 Popover 高级输入 |

---

## 2. 文件结构

```
src/components/data-table/
├── index.ts                     # 项目级公共入口，新业务优先从这里导入
├── relational-data-table.tsx    # 关系型数据表适配层
├── structured-value-preview.tsx # 通用结构化值有界摘要、只读详情与复制
└── redis-editable-data-table.tsx # Redis 集合编辑适配层

src/components/ui/data-table/
├── types.ts                    # 核心类型定义
├── data-table-context.tsx      # React Context + useDataTable() Hook
├── fixed-column-virtualization.ts # DataTable 横向列窗口虚拟器
├── virtual-scroll-area.tsx     # Base UI ScrollArea 封装（暴露 viewportRef）
├── data-table-header.tsx       # 固定表头 + 列宽拖拽手柄
├── data-table-body.tsx         # 虚拟滚动容器 + 行/单元格渲染
├── cell-editor/                # 单元格编辑器与类型感知高级输入
│   ├── cell-editor.tsx
│   ├── advanced-cell-editor-popover.tsx # boolean/date/time/datetime/enum 轻量 Popover
│   ├── editor-registry.ts
│   └── value-format.ts
├── data-table-empty.tsx        # 空状态组件
├── data-table.tsx              # 主组件（组装所有子组件）
└── index.ts                    # 底层实现导出，业务代码避免直接依赖
```

JSON 与长文本高级编辑不在 DataTable 内部实现大编辑器，而是复用 `@/components/editor` 导出的 `CodeEditorDialog`。

### 依赖关系

```
data-table.tsx
  ├── data-table-context.tsx    (Context Provider)
  ├── virtual-scroll-area.tsx   (ScrollArea 容器)
  ├── data-table-header.tsx     (表头)
  ├── data-table-body.tsx       (虚拟滚动体)
  │   └── cell-editor/          (输入框 + Popover/Dialog 高级编辑)
  └── data-table-empty.tsx      (空状态)

data-table-header.tsx ──→ data-table-context.tsx (useDataTable)
data-table-body.tsx   ──→ data-table-context.tsx (useDataTable)
```

---

## 3. 技术选型

| 领域 | 依赖 | 版本 | 用途 |
|------|------|------|------|
| 表格状态管理 | `@tanstack/react-table` | ^8.21.3 | 列宽状态 (`columnSizing`)、表头组、`getResizeHandler()` |
| 虚拟滚动 | `@tanstack/react-virtual` + 项目内列虚拟器 | ^3.13.23 / — | `useVirtualizer` 按需渲染可见行；`useFixedColumnVirtualizer` 在 Body 内按需渲染可见普通列 |
| 自定义滚动条 | `@base-ui/react` (ScrollArea) | ^1.6.0 | Base UI 原语，提供 Thumb/Track/Corner |
| 样式工具 | `tailwind-merge` + `clsx` | — | `cn()` 类名合并 |

> **为什么不用 shadcn `ScrollArea` 组件直接包裹？**
> 共享 `ScrollArea` 暴露 `viewportRef`，而虚拟滚动器必须将 ref 绑定到其真实 `Viewport` 滚动元素。因此 `virtual-scroll-area.tsx` 直接使用 Base UI 原语组装，保持项目 ScrollArea 的样式与滚动节点语义。

---

## 4. 核心类型

### 4.1 `DataTableColumn`

```typescript
interface DataTableColumn {
  id: string;                                    // 列唯一标识
  header: string;                                // 表头显示文本
  typeName?: string;                             // 业务适配器提供的类型标签
  nullable?: boolean;                            // 可选领域元数据
  isPrimaryKey?: boolean;                        // 可选领域元数据
  isUnique?: boolean;                            // 可选领域元数据
  isWritable?: boolean;                          // 可选领域元数据
  dataCategory?: DataTableCellDataCategory;      // 类型感知编辑分类
  maxLength?: number | null;                     // 文本最大长度
  numericPrecision?: number | null;              // 数值精度
  numericScale?: number | null;                  // 数值小数位
  enumValues?: string[] | null;                  // 枚举候选值
  width?: number;                                // 初始宽度 (默认 160px)
  minWidth?: number;                             // 拖拽最小宽度 (默认 60px)
  maxWidth?: number;                             // 拖拽最大宽度
  cell?: (value: unknown, rowIndex: number) => React.ReactNode; // 自定义渲染
  disableResizing?: boolean;                     // 禁止调整此列
  frozen?: boolean;                              // 是否冻结此列 (默认 false)
}
```

### 4.2 `DataTableProps`

```typescript
interface DataTableProps {
  preset?: "default" | "database" | "compact" | "keyValue"; // 项目级视觉/行为预设
  columns: DataTableColumn[];
  rows: unknown[][];                             // 二维数组，内层数组顺序匹配 columns
  rowHeight?: number;                            // 固定行高 (默认 32px)
  overscan?: number;                             // 可视区域外预渲染行数 (默认 20)
  columnOverscan?: number;                       // 可视区域外预渲染非冻结列数 (默认 2)
  enableColumnResizing?: boolean;                // 启用列宽拖拽 (默认 true)
  rowNumberOffset?: number;                      // 行号绝对偏移，分页表格通常为 (page - 1) * pageSize
  showRowNumbers?: boolean;                      // 是否显示内建行号栏 (默认 true)
  rowNumberWidth?: number;                       // 行号栏宽度 (默认 48px)
  rowNumberFormatter?: DataTableRowNumberFormatter; // 自定义行号显示
  renderColumnHeaderMeta?: DataTableHeaderMetaRenderer; // 业务适配器注入表头元数据
  onRowClick?: (rowIndex: number, rowData: unknown[]) => void;
  selectedRowIndexes?: number[];                 // 受控选中行
  currentRowIndex?: number | null;               // 当前行，仅用于焦点/活动行高亮
  onRowSelect?: (rowIndex: number, rowData: unknown[], event: React.MouseEvent) => void;
  onRowContextMenu?: (target: DataTableContextMenuTarget, event: React.MouseEvent) => void;
  renderRowContextMenu?: (target: DataTableContextMenuTarget) => React.ReactNode;
  selectedCell?: { rowIndex: number; columnId: string } | null;
  onCellSelect?: (rowIndex: number, columnId: string, value: unknown, event: React.MouseEvent) => void;
  onCellDoubleClick?: (rowIndex: number, columnId: string, value: unknown, event: React.MouseEvent) => void;
  isCellEditable?: (rowIndex: number, columnId: string, value: unknown) => boolean;
  editingCell?: { rowIndex: number; columnId: string; value: unknown } | null;
  onCellEditCommit?: (rowIndex: number, columnId: string, value: string) => void;
  onCellEditCancel?: () => void;
  className?: string;
  emptyMessage?: string;                         // 无数据时提示 (默认 "暂无数据")
  frozenColumnIds?: string[];                    // 冻结列 ID 列表 (默认 [], 不冻结)
}
```

### 4.3 `RelationalDataTable`

`RelationalDataTable` 位于 `src/components/data-table/`，是关系型数据浏览的业务适配器。它接收 `ColumnMeta[] + rows` 或 `QueryResult` 风格数据，将关系型列元数据映射成通用 `DataTableColumn[]`，并通过 `renderColumnHeaderMeta` 注入数据库表头 Badge。

`RelationalDataTable` 不拥有分页、事务、IPC mutation、DML 预览或 tab dirty 状态；这些仍由 `TableDataView` 管理。

当 `ColumnMeta.dataCategory === "structured"` 时，适配器注册 `StructuredValuePreview`。该组件只接收 `unknown`，为 Array/Object 生成有界摘要，在 Dialog 中显示最多 64 KiB 的只读 JSON，并从同一有界 formatter 复制；循环引用或序列化失败显示 `<不可序列化结构>`。共享组件不读取 driver name 或 ClickHouse type name，因此同一类别可复用于 PostgreSQL array/composite、Oracle collection/object 与后续文档数据库。ClickHouse Phase 3 的通用预览已足够清楚，暂不创建专属 value-inspector tab；需要 type-aware 交互时仍可通过 content-tab registry 新增专属 tab，而不是向共享 renderer 堆 driver 分支。

### 4.4 `RedisEditableDataTable`

`RedisEditableDataTable` 位于 `src/components/data-table/`，是 Redis 集合类型的业务适配器。它接收 Redis editable draft，把 `hash/list/set/zset/stream` 映射为二维 `columns + rows`，并把单元格提交回写到对应 draft 结构。Stream 采用扁平行模型：一行表示一个 field，列为 `ID / Field / Value`，同一个 entry 的多字段会重复显示相同 ID。

RedisJSON 不使用 DataTable；它走统一 `CodeEditor`，固定 JSON 语言和 `jsonDocument` preset。

`RedisEditableDataTable` 不拥有新增、删除、保存、校验、TTL 或 dirty tab 状态；这些仍由 `KeyValueView` 管理。

### 4.5 `DataTableRowData` (内部类型)

`@tanstack/react-table` 需要对象数组作为数据源。内部自动将 `unknown[][]` 转换为：

```typescript
interface DataTableRowData {
  [columnId: string]: unknown;       // 每列的值
  __rowIndex: number;                // 原始行索引
  __originalRow: unknown[];          // 原始行数据
  __isVirtualEmptyRow?: boolean;     // 空表占位虚拟行，不可选择/编辑/删除
}
```

右键菜单目标由 `DataTableContextMenuTarget` 区分，父组件可据此渲染不同菜单：

```typescript
type DataTableContextMenuTarget =
  | { kind: "rowNumber"; rowIndex: number; rowData: unknown[] }
  | { kind: "cell"; rowIndex: number; rowData: unknown[]; columnId: string; value: unknown };
```

---

## 5. 数据流

```
                    ┌─────────────────────────────────────────────┐
                    │              DataTable (主组件)              │
                    │                                             │
   rows[][]  ──────►│  convertRows()   ──► DataTableRowData[]     │
   columns[] ──────►│  convertColumns()──► ColumnDef[]            │
                    │         │                                   │
                    │         ▼                                   │
                    │  useReactTable({ data, columns, ... })      │
                    │         │                                   │
                    │  ┌──────┴──────┐                            │
                    │  │  Context    │  table, rowHeight, columns │
                    │  └──────┬──────┘                            │
                    │         │                                   │
                    │  ┌──────▼──────┐    ┌───────────────────┐   │
                    │  │ DataTable   │    │ DataTable         │   │
                    │  │ Header      │    │ Body              │   │
                    │  │ (全量表头)  │    │ (行*列窗口)       │   │
                    │  │ headerRef ◄─┼────┼─ viewportRef      │   │
                    │  │ (scrollLeft │    │ (virtualizers     │   │
                    │  │  synced)    │    │  按需渲染行/列)   │   │
                    │  └─────────────┘    └───────────────────┘   │
                    │                     ▲                       │
                    │  VirtualScrollArea ─┘                       │
                    │  (Base UI ScrollArea viewport)              │
                    └─────────────────────────────────────────────┘
```

### 关键路径

1. **数据转换**: `unknown[][]` → `DataTableRowData[]`（`convertRows()`），在 `useMemo` 中完成
2. **列宽状态**: `@tanstack/react-table` 管理 `columnSizing` state，拖拽实时更新
3. **纵向虚拟渲染**: `useVirtualizer` 根据 viewport 的 `scrollTop` 计算可见行索引范围
4. **横向列虚拟渲染**: `DataTableBody` 内部的 `useFixedColumnVirtualizer` 根据列宽、viewport 宽度与 `scrollLeft` 计算可见非冻结列窗口，冻结列始终渲染
5. **横向同步**: viewport 的 `scroll` 事件 → 设置 `header.scrollLeft`

### 5.1 Body 列虚拟化策略

宽字段表的核心性能瓶颈不是行数本身，而是纵向滚动时每个可见行仍然渲染全部字段。DataTable 因此在 Body 内引入横向列窗口：表体只渲染 `可见行范围 × 可见列范围` 的普通单元格，而不是每个可见行都渲染全部字段。默认 `columnOverscan = 2`，只在可视区域左右额外保留少量非冻结列，降低宽表纵向滚动时的 React/DOM 工作量。

列虚拟化只应用在 Body。Header 保持全量表头渲染，并继续通过 `header.scrollLeft` 与 body viewport 同步。表头 DOM 规模只与字段数相关，不会放大成 `行数 × 字段数`；让 Header 退出列窗口可以避免横向滚动跨列边界时，Header 同时经历 imperative scroll 同步和 React 表头单元格挂载/卸载。

`useFixedColumnVirtualizer` 必须下沉在 `DataTableBody` 内部，而不是放在 `DataTable` 父组件中。横向滚动跨列窗口边界时会更新列窗口 state；如果该 state 位于父组件，会导致 Header 也随父组件/context 一起重渲染，即使 Header 不直接使用列虚拟器，也可能造成横向滚动时表头抖动。列窗口 state 只应影响 Body。

列虚拟器初始化时必须处理 viewport ref 或尺寸尚不可用的情况。若 `viewportWidth = 0`，它会临时渲染全部非冻结列，避免首屏只显示 `columnOverscan + 1` 列而后续列空白；挂载后通过 `requestAnimationFrame` 和 `ResizeObserver` 再同步真实 viewport 尺寸，收敛回正常列窗口。

Body 外层仍保留完整 `totalSize` 宽度，因此横向滚动条、列宽拖拽和表头/表体 `scrollLeft` 同步行为不变。Body 普通列使用绝对定位落在原始列偏移位置；行号栏和冻结列使用 sticky overlay，始终保留在左侧，不参与普通列窗口裁剪。

---

## 6. 表头固定方案

表头 **不在** ScrollArea 内部，而是独立渲染在外部：

```
┌──────────────────────────────┐
│  DataTableHeader (overflow: hidden)  │  ← headerRef 同步 scrollLeft
├──────────────────────────────┤
│  VirtualScrollArea           │
│  ┌──────────────────────────┐│
│  │  Viewport (overflow: auto)││  ← viewportRef 虚拟滚动器的 scroll element
│  │  ┌──────────────────────┐││
│  │  │  virtual body div    │││  ← position: relative; height: totalSize
│  │  │  ┌────────────────┐  │││
│  │  │  │ row (absolute) │  │││  ← translateY(virtualRow.start)
│  │  │  └────────────────┘  │││
│  │  └──────────────────────┘││
│  └──────────────────────────┘│
│  ┌──┐                        │
│  │■■│ ScrollBar (vertical)   │
│  └──┘                        │
└──────────────────────────────┘
```

**为什么不用 `position: sticky`？**
将表头移出 ScrollArea，避免它参与虚拟滚动容器的布局和裁切；通过 JS 同步 `scrollLeft` 是更可靠的方式。

---

## 7. 列宽拖拽实现

基于 `@tanstack/react-table` 的 `columnSizing`：

```
用户拖拽 resize handle
  → header.getResizeHandler() 捕获 mousedown
  → mousemove 期间更新 columnSizing state
  → onColumnSizingChange(setColumnSizing) 触发重渲染
  → header.getSize() / cell.column.getSize() 输出新宽度
  → table.getTotalSize() 更新总宽度 → 影响横向滚动
```

双击 handle 调用 `header.column.resetSize()` 恢复初始宽度。

---

## 8. 扩展指南

### 8.1 行号栏、行选择与右键菜单

当前实现内建最左侧行号栏，宽度固定为 `48px`，表头留空。行号栏显示 `rowNumberOffset + rowIndex + 1`，用于承担行选择：点击行号选中当前行，Ctrl/Cmd 点击行号由父组件处理多选/取消选择。普通单元格点击不改变 `selectedRowIndexes`。

父组件通过 `selectedRowIndexes` 控制行级操作选择，通过 `currentRowIndex` 控制当前行高亮。右键菜单由 `renderRowContextMenu` 提供，并通过 `DataTableContextMenuTarget.kind` 区分行号栏菜单与单元格菜单；虚拟空行不会触发行选择或右键菜单。

```typescript
rowNumberOffset?: number;
scrollToRowIndex?: number | null;
scrollToRowSignal?: number;
selectedRowIndexes?: number[];
currentRowIndex?: number | null;
pendingDeleteRowIndexes?: number[];
draftRowIndexes?: number[];
dirtyCells?: Array<{ rowIndex: number; columnId: string }>;
onRowSelect?: (rowIndex, rowData, event) => void;
renderRowContextMenu?: (target) => React.ReactNode;
```

### 8.2 单元格选择与编辑

普通单元格点击用于选择单元格，并将所在行设为 `currentRowIndex`。如果点击的行不在 `selectedRowIndexes` 中，父组件应清空行选择，避免旧的行级操作选择继续生效；如果点击的是已选中行内的单元格，则保留行选择。父组件通过 `selectedCell` 控制单元格高亮，通过 `onCellSelect` 接收点击事件。当前只支持单个单元格选择，范围选择、复制、拖拽填充属于后续能力。

当前 DataTable 数据页已接入轻量右键菜单：行号栏菜单提供删除记录、复制记录、刷新；单元格菜单提供设置为 `NULL`、设置为空白字符串、删除记录、复制单元格、刷新。写入类菜单仍由父组件结合驱动能力、资源能力、列元数据决定是否启用。

DataTable 写入入口由 `TableDataView` 组合驱动 capability 与 `QueryResult` 资源能力决定：单元格更新要求 `tableRowMutator`、`sourceWritable`、`rowLocatorStrategy` 和列级 `isWritable`；删除要求相同 locator 能力与选中行；新增要求 `tableRowInserter`、`sourceInsertable` 且当前容器为真实表。关系型表使用 `primaryKey` locator；ClickHouse 普通 Local `MergeTree/ReplacingMergeTree` 使用 `rowSnapshot` locator，sorting/primary key 不视为唯一。View/MV、复杂列、生成列与未支持 engine 保持只读。

SQLite Phase 5 在 Phase 4 写入范围上开启 `transactionManager=true`，继续复用现有本地 change set、DML 预览、保存和通用事务工具栏。可写与可开始事务的范围只覆盖 writable profile 中具备显式完整非二进制主键的普通表；read-only profile、view、无主键表和二进制主键表返回 `sourceWritable=false` 与 `sourceInsertable=false`。普通非二进制列可写，主键列可在 insert 时填写但不能 update，generated 和 BLOB/binary 列保持 `isWritable=false`，避免把 `<BINARY>` 展示标记覆盖到真实二进制数据。SQLite 不使用 `rowid` fallback，复合主键 update/delete 必须提供全部主键列。未开启事务时保存仍为即时提交；开始事务会执行 `BEGIN IMMEDIATE`，并受五秒 busy timeout 限制。

当前实现为单元格级受控编辑：只有资源可写、当前行能构造 locator 且列级 `isWritable=true` 时，单击或双击才会进入 `editingCell`。`Enter` 或失焦提交到本地 change set，`Esc` 取消；后端仍重复校验真实表、locator、类型、行数上限和远端事实。这样已知只读列不会先允许编辑再在保存时抛出不可理解的阶段提示。用户提示必须遵守 [用户可见文案指南](./user-facing-copy.md)，说明限制、原因和下一步操作。

编辑器入口位于 `cell-editor/cell-editor.tsx`。默认使用普通文本输入，`number`、`uuid`、普通 `string` 也保持文本输入，不使用数字输入框且不提供 UUID 生成。`editor-registry.ts` 根据 `ColumnMeta.dataCategory` 与长度/类型名判断是否显示高级按钮：`date` 使用 shadcn `Calendar`；`time` 使用通用 `TimePicker`；`datetime` 使用通用 `DateTimePicker`，由 `Calendar + TimePicker` 组合，输出固定为 `yyyy-MM-dd HH:mm:ss` 且不做时区转换；`boolean` 提供 `true/false/NULL`；`enum` 展示后端枚举值；这些轻量类型仍通过 shadcn `Popover` 展开。`json` 与长文本改用项目级 `CodeEditorDialog`，弹窗内复用 Monaco 封装的 `CodeEditor`，提供工具栏、Dirty 状态、行数/字符数和受控“应用”流程；JSON 场景提供“格式化”工具按钮，并在应用前校验 JSON。弹窗禁止遮罩点击和 `Esc` 关闭；右上角关闭按钮在 Dirty 状态会先要求确认放弃未应用的修改，避免误关闭丢失编辑内容。应用后仍走同一套 `onCellEditCommit` 与 change set 流程。表格浏览会在后端先把部分驱动不易直接 JSON 化或需要精确保留的列转成展示文本，例如 MySQL 的 `bigint/bigint unsigned/mediumint/decimal/bit/year/point` 与 PostgreSQL 的 `bigint/int8/numeric`、几何、网络、range 等类型；MySQL 的 `binary/varbinary/blob` 不直接显示原始内容，而是以 `<BINARY>` 标记展示。`binary/blob` 当前没有专用高级编辑器，仍允许文本入口，最终由后端或数据库在 DML 预览/保存阶段校验。

DataTable 数据页采用前端本地 change set：新增行先写入本地 `inserts` 并追加到当前页底部，草稿行行号显示 `*`，同时通过 `scrollToRowIndex/scrollToRowSignal` 自动滚动到草稿行；如果草稿行完全没有填写任何列，用户点击其他区域时会自动撤掉这条空草稿。单元格编辑与右键设置值先写入本地 `updates`，删除先写入本地 `deletes`。组件通过 `draftRowIndexes`、`dirtyCells` 与 `pendingDeleteRowIndexes` 反馈草稿、修改和待删除样式。保存时当前版本通过 `commit_table_change_set` 按 insert -> update -> delete 顺序批量提交；底部 dirty 摘要旁的 `DML` 按钮通过 `preview_table_change_set` 打开 Drawer 预览 SQL。新增行未填写列会从 INSERT 中省略，让数据库 default / identity / auto increment 生效。若当前 tab 已开启事务，保存只写入该 tab 的事务连接，最终结果由工具栏“提交”或“回滚”决定；未开启事务时保存仍是即时提交。Oracle 事务 begin 只 pin 当前 tab 的 Oracle connection，不执行 SQL `BEGIN`；保存、浏览和分页统计在事务期间复用该 connection。SQLite tab runtime 使用两连接池：`BEGIN IMMEDIATE` 后一条 connection 被 pin 给事务 browse/page stats/DML，第二条只服务 metadata PRAGMA；当前 tab 可看到未提交变化，独立连接仍看到最近一次 committed snapshot。SQLite commit/rollback 成功后释放 pinned connection；如果 `COMMIT` 因 reader lock 等原因失败，事务状态和 pinned connection 会保留，用户可重试提交或回滚。关闭 tab 会先 best-effort rollback；SQL Editor 不参与该事务。事务开启时 DataTable 外框显示事务态边框，并在表格下方状态栏、分页组件上方提示未提交修改可能持有锁；若事务中保存 change set 失败，后端保留活动事务和此前已执行但未提交的语句，前端把 tab 标记为 `rollbackRecommended`，状态栏显示“建议回滚”，并阻止继续提交事务，要求用户回滚后重试。撤回会清空本地 change set 并恢复 query 数据展示。分页、分页统计快照、页码输入态、行/单元格选择、编辑态、待删除确认、事务状态、事务告警和 change set 都保存在 tab runtime state 中，因此切换 tab 或 `Activity hidden` 不会丢失当前 DataTable 内容状态；只有撤回、保存成功、确认丢弃刷新、提交/回滚事务或真正关闭 tab 才会清理。

ClickHouse 基础 CRUD 不提供事务。单次 change set 最多 100 行和 2,000 个单元格；Update/Delete 在 preview 与 execute 前分别核对快照匹配数，使用请求级 `mutations_sync=1`，并在执行后核对旧值消失与新值存在。只有 `applied` 清空草稿；`outcomeUnknown` 保留草稿并提示先刷新核对，`conflict` 保留草稿并提示刷新后重新编辑。生产路径不自动重试。删除在进入本地 `deletes` 前要求用户输入当前表名确认。

```typescript
selectedCell?: { rowIndex: number; columnId: string } | null;
onCellSelect?: (rowIndex, columnId, value, event) => void;
isCellEditable?: (rowIndex, columnId, value) => boolean;
editingCell?: { rowIndex: number; columnId: string; value: unknown } | null;
onCellEditCommit?: (rowIndex, columnId, value) => void;
onCellEditCancel?: () => void;
```

### 8.3 懒加载分页统计与页码跳转

普通翻页继续只依赖 `browse_table_data` 的 `hasNextPage`，不会每次执行 `COUNT(*)`。分页控件布局为“第一页 / 上一页 / 当前页号 / 下一页 / 最后一页”：点击第一页直接跳到第 1 页；点击上一页/下一页只改变当前页；点击最后一页才调用 `get_table_page_stats` 获取 `totalRows/totalPages` 并跳转到最后一页。

当前页号默认只显示当前页；当分页统计已经加载后显示为 `当前页 / 总页数`。点击页号会切换为输入框，`Enter` 或失焦提交，`Esc` 取消。提交页码跳转时，前端先校验正整数，再按需调用 `get_table_page_stats`，后端会使用同一份 `TableBrowseQuery` 统计总数并校验 `requestedPage` 是否在 `1..=totalPages` 范围内。空表按 `totalPages = 1` 处理，避免分页 UI 进入第 0 页。

`TableBrowseQuery` 是表格浏览和统计共用的查询条件源，当前 v1 只允许空 `filters/sort`。后续接入过滤或排序时，`browse_table_data` 与 `get_table_page_stats` 必须从同一份 query builder 生成条件，确保最后一页和页码跳转的统计范围与当前表格内容一致。统计结果是按需快照，保存成功、撤回、刷新、事务提交/回滚、pageSize/query/container 变化后都会失效，下次需要跳转时重新获取。

### 8.4 添加排序

```typescript
enableSorting?: boolean;
onSortingChange?: (sortBy: string, direction: 'asc' | 'desc') => void;
```

在 `useReactTable` 中启用 `getSortedRowModel()`，在 `DataTableHeader` 添加排序箭头。

### 8.5 冻结列

**当前实现**：默认不冻结任何列。通过 `frozenColumnIds` prop 或列定义 `frozen: true` 控制。

```tsx
// 方式一：table 级别
<DataTable columns={columns} rows={rows} frozenColumnIds={["id", "name"]} />

// 方式二：column 级别
const columns = [
  { id: "id", header: "ID", frozen: true },
  { id: "name", header: "Name", frozen: true },
  { id: "email", header: "Email" },
];
```

**实现原理**：

- Header 遍历全部列并检查 `frozenColumnIdSet.has(columnId)`；Body 仅对冻结列和当前普通列窗口检查对应状态
- 冻结列使用 `position: sticky` + 动态计算 `left` 偏移量
- 偏移量 = 前序冻结列宽度之和（仅累加冻结列，跳过非冻结列）

**后续扩展：右键 "冻结该列"**

预计实现方案：

```
┌──────────────────────────────────────────────────────────────┐
│  Context Menu (DataTableHeader 右键)                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 冻结该列          ← onFreezeColumn(columnId)            │ │
│  │ 取消冻结          ← onUnfreezeColumn(columnId)          │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
  Parent Component (受控状态)
  const [frozenIds, setFrozenIds] = useState<string[]>([]);
  onFreezeColumn = (id) => setFrozenIds(prev => [...prev, id]);
  onUnfreezeColumn = (id) => setFrozenIds(prev => prev.filter(x => x !== id));
         │
         ▼
  <DataTable frozenColumnIds={frozenIds} onFreezeColumn={...} onUnfreezeColumn={...} />
```

需要在 `DataTableProps` 中新增回调：

```typescript
/** 右键菜单 "冻结该列" 回调 (Future) */
onFreezeColumn?: (columnId: string) => void;
/** 右键菜单 "取消冻结" 回调 (Future) */
onUnfreezeColumn?: (columnId: string) => void;
```

### 8.6 自定义单元格渲染

通过 `DataTableColumn.cell` 回调：

```typescript
{
  id: "status",
  header: "Status",
  cell: (value) => (
    <Badge variant={value === "active" ? "default" : "secondary"}>
      {String(value)}
    </Badge>
  ),
}
```

### 8.7 支持对象数据源

当前仅接受 `unknown[][]`。如需直接接受对象数组：

```typescript
// 新增 props
rows?: unknown[][];
data?: TData[];  // 泛型对象数据
```

在 `convertRows()` 中分支处理两种格式。

---

## 9. 使用示例

### 基础用法

```tsx
import { DataTable } from "@/components/data-table";

<DataTable
  columns={[
    { id: "name", header: "用户名", width: 200 },
    { id: "email", header: "邮箱", width: 250 },
    { id: "age", header: "年龄", width: 80 },
  ]}
  rows={[
    ["Alice", "alice@example.com", 30],
    ["Bob", "bob@example.com", 25],
  ]}
/>
```

### 自定义单元格

```tsx
<DataTable
  columns={[
    { id: "name", header: "名称", width: 200 },
    {
      id: "score",
      header: "分数",
      width: 120,
      cell: (value) => {
        const num = Number(value);
        return (
          <span className={num >= 90 ? "text-green-500" : "text-red-500"}>
            {num}
          </span>
        );
      },
    },
  ]}
  rows={data}
/>
```

### 配合 TableDataView 使用

```tsx
// src/features/workbench/content/components/TableDataView.tsx
import { RelationalDataTable } from "@/components/data-table";

<RelationalDataTable
  columns={data?.columns}
  rows={data?.rows ?? []}
  rowHeight={32}
  emptyMessage={`「${tableName}」暂无数据`}
/>
```

---

## 10. 注意事项

| 项目 | 说明 |
|------|------|
| `rows` 引用稳定性 | `rows` 变化会触发 `convertRows()` 重计算，大数据量时注意引用稳定性 |
| `columnSizing` 受控 | 列宽状态由组件内部管理，外部无法持久化列宽。如需持久化，暴露 `onColumnSizingChange` 回调 |
| 固定行高 | 当前仅支持固定 `rowHeight`。如需自适应高度，需在 `useVirtualizer` 中启用 `measureElement` |
| Body 列窗口 | DataTable Body 会按当前列宽计算横向窗口，只渲染可见非冻结列和少量 `columnOverscan`；Header 仍全量渲染 |
| 列窗口初始化 | viewport 尺寸未知时临时渲染全部非冻结列，避免首屏只显示前三列；挂载后自动收敛到真实列窗口 |
| 虚拟空行 | 空表会渲染一行 `(N/A)` 占位，仅用于展示列结构，不参与选择、删除或编辑 |
| 行号栏 | DataTable 默认显示固定行号栏，可通过 `showRowNumbers=false` 关闭；冻结列 left 偏移会避开可见行号栏 |
| 分页统计 | 普通翻页不统计总数；点击最后一页或提交页码跳转时才通过 `get_table_page_stats` 懒加载总行数/总页数；total 可以是精确 decimal string，比较/格式化使用 BigInt helper，超 `u32` 的最后页不能直接跳转 |
| 选择边界 | 行选择由行号栏触发；普通单元格点击更新 `selectedCell` 与 `currentRowIndex`，若点击未选中行则清空旧的 `selectedRowIndexes` |
| 最后一列分割线 | 表头和单元格的最后一列也保留右侧分割线，便于横向阅读 |
| 编辑提交 | DataTable 只负责输入交互，真实保存由父组件通过 `onCellEditCommit` 完成 |
| `data-slot` 属性 | 所有内部元素均带有 `data-slot` 属性，可用于 CSS 选择器定位 |
| 兼容性 | `@tanstack/react-table` 和 `@tanstack/react-virtual` 均已安装，无需额外安装依赖 |

---

## 11. 项目级接入约束

- 新业务优先从 `@/components/data-table` 导入；`@/components/ui/data-table` 是底层实现目录，除 DataTable 子系统内部外不作为首选业务入口。
- 底层 `DataTable` 只负责二维数据渲染、选择、编辑入口、虚拟滚动、列宽、冻结列和视觉状态，不直接实现 SQL、Redis 或保存逻辑。
- 关系型表使用 `RelationalDataTable`；Redis `hash/list/set/zset/stream` 编辑使用 `RedisEditableDataTable`，不要在 Redis 视图内重新手写表格。
- Redis 集合新增/删除按钮由业务预览 Header 控制；`RedisEditableDataTable` 只负责表格展示、行选择上报和单元格提交。
- RedisJSON 使用通用 `CodeEditor`，不要为了 JSON module key 新建表格适配。
- 业务适配器负责把领域数据映射为 `columns + rows`、提供表头元数据渲染、处理新增/删除/保存/校验；DataTable 本身不拥有业务 change set。
- 结构化值 renderer 只按中性 `dataCategory="structured"` 注册；不得在公共 DataTable 内按 ClickHouse driver/type name 分支。
- `preset="database"` 保留当前关系型数据页密度与表头高度；`compact` / `keyValue` 面向 Redis 等轻量集合视图。
- `showRowNumbers=false` 可用于不需要内建行号栏的轻量表格；需要 Redis list 的 0-based index 时应显式建一列，而不是复用 1-based 行号语义。
- `src/features/workbench/content/components/DataTable.tsx` 是早期遗留轻量表格；新增功能不应继续依赖它，后续确认无引用后可单独清理。
