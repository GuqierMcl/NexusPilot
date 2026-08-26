# 数据库驱动图标接入指南

本文档记录 NexusPilot 新增或调整数据库驱动品牌图标的标准流程。驱动图标用于连接树、数据库类型选择窗口，以及后续可能复用品牌标识的前端区域。

原则：

- 不再手动下载数据库 SVG 到 `src/assets/`。
- 使用最新 `@thesvg/cli` 生成 React 组件，命令使用 `bunx @thesvg/cli`，不固定 CLI 版本。
- 生成组件统一放在 `src/components/icons/database/generated/`。
- 功能代码只从 `src/components/icons/database/index.ts` adapter 导入图标，不直接依赖 generated 文件。
- 需要明暗模式差异时，优先使用图标源提供的 `light` / `dark` variant，不在业务组件里用 className 修改品牌图形颜色。

---

## 1. 相关文件

| 文件或目录 | 职责 |
| --- | --- |
| `src/components/icons/database/generated/` | `@thesvg/cli` 生成的 TSX 图标组件 |
| `src/components/icons/database/index.ts` | 对外稳定 adapter：注册图标、导出组件、维护 `DATABASE_ICONS` 映射 |
| `src/components/icons/database/mysql-icon.tsx` | MySQL 明暗 variant 切换组件；其他需要主题 variant 的图标可按此模式新增 |
| `src/components/icons/database/README.md` | 图标组件目录的本地说明 |
| `src/features/workbench/explorer/driver-configs/*.tsx` | 已实现驱动的 `pickerIcon` 和 `treeVisual.icon` 引用 |
| `src/features/workbench/explorer/components/SelectDatabaseTypeDialog.tsx` | 数据库类型选择窗口；静态列表通过 `iconKey` 读取品牌图标 |
| `docs/guides/ADD_NEW_DATABASE_DRIVER.md` | 新增驱动主流程；图标部分应链接到本文档 |

---

## 2. 选择图标 slug 和 variant

先在 theSVG 上确认图标 slug、可用 variant 和 license：

```bash
bunx @thesvg/cli search neo4j
```

常用 slug 示例：

| 数据库 | slug | 常用 variant |
| --- | --- | --- |
| MySQL | `mysql` | `light` / `dark` |
| PostgreSQL | `postgresql` | `default` |
| Redis | `redis` | `default` |
| SQLite | `sqlite` | `default` |
| Oracle | `oracle` | `default` |
| Microsoft SQL Server | `microsoft-sql-server` | `default` |
| MongoDB | `mongodb` | `default` |
| Neo4j | `neo4j` | `default` |
| Amazon Neptune | `aws-amazon-neptune` | `default` |
| ArangoDB | `arangodb` | `default` |
| Elasticsearch | `elasticsearch` | `default` |

注意事项：

- 如果 default 图标在亮色或暗色背景下不可读，先检查是否有 `light` / `dark` variant。
- 不要为了修正品牌图形本身颜色而在业务层写 Tailwind selector，例如 `[&_*]:fill-current`。布局尺寸、透明度、禁用态 opacity 这类 UI 样式可以继续通过 `className` 控制。
- 每次新增品牌图标都要留意 license。包本身 MIT 不代表每个品牌图标都是 MIT；以 theSVG registry 中该 icon 的 license 字段为准。
- `Fair Use`、品牌政策或指称性商标使用不是 Apache-2.0 授权；这类图标只用于准确识别已支持或明确标注为规划中的数据库，不得暗示厂商赞助或背书。带有 `ND` 条款的图标必须保持视觉作品不变，TSX 规范化仅限渲染所需的技术兼容转换。
- 如果找不到准确品牌图标，不要临时下载来源不明 SVG。先使用通用 `Database` / `Server` 类图标，或在 issue/任务说明中记录缺口。

---

## 3. 生成图标组件

默认图标生成到 `generated/default`：

```bash
bunx @thesvg/cli add neo4j --format jsx --dir ./src/components/icons/database/generated/default
```

一次生成多个默认图标：

```bash
bunx @thesvg/cli add postgresql redis sqlite mongodb --format jsx --dir ./src/components/icons/database/generated/default
```

需要明暗 variant 时，按 variant 分目录生成，避免同 slug 文件互相覆盖：

```bash
bunx @thesvg/cli add mysql --format jsx --variant light --dir ./src/components/icons/database/generated/mysql-light
bunx @thesvg/cli add mysql --format jsx --variant dark --dir ./src/components/icons/database/generated/mysql-dark
```

生成后检查输出路径和组件名。例如：

```text
src/components/icons/database/generated/default/neo4j.tsx
src/components/icons/database/generated/mysql-light/mysql-light.tsx
src/components/icons/database/generated/mysql-dark/mysql-dark.tsx
```

---

## 4. 规范化生成 TSX

`@thesvg/cli` 的 JSX 输出来自原始 SVG，可能需要少量 React/TypeScript 规范化。完成生成后必须跑：

```bash
bun run tsc --noEmit
```

若类型检查报错，按下面规则修正 generated 文件：

1. 根 `<svg>` 必须透传 props，并且 `{...props}` 放在固定属性之后，方便调用方覆盖 `className` / `width` / `height`：

```tsx
export function Neo4jIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" {...props}>
            {/* ... */}
        </svg>
    );
}
```

2. 移除 XML 声明：

```tsx
// 删除这一行，TSX 中非法
<?xml version="1.0" encoding="UTF-8"?>
```

3. 把 XML 属性改为 React 属性：

```tsx
// 改造前
<svg xml:space="preserve" xmlns:xlink="http://www.w3.org/1999/xlink">

// 改造后
<svg xmlSpace="preserve" xmlnsXlink="http://www.w3.org/1999/xlink">
```

4. 把字符串 style 改成 React style object：

```tsx
// 改造前
<path style="fill:#336791;stroke:none" />

// 改造后
<path style={{ fill: "#336791", stroke: "none" }} />
```

5. 保持 generated 组件只做“能被 React 使用”的机械修正，不在 generated 文件里加入业务逻辑。明暗模式、命名别名、映射表都放到 adapter。

---

## 5. 注册 adapter

在 `src/components/icons/database/index.ts` 中导入生成组件：

```ts
import Neo4jIcon from "@/components/icons/database/generated/default/neo4j";
```

把图标加入 `DATABASE_ICONS`：

```ts
export const DATABASE_ICONS = {
    // ...existing icons
    neo4j: Neo4jIcon,
} satisfies Record<string, DatabaseIconComponent>;
```

导出稳定组件名：

```ts
export {
    Neo4jIcon,
};
```

如果某个品牌需要明暗 variant，不要把两个 generated 组件直接暴露给业务层。新增一个稳定 wrapper，例如：

```tsx
import type { SVGProps } from "react";
import { useTheme } from "next-themes";

import ExampleDarkIcon from "@/components/icons/database/generated/example-dark/example-dark";
import ExampleLightIcon from "@/components/icons/database/generated/example-light/example-light";

export function ExampleIcon(props: SVGProps<SVGSVGElement>) {
    const { resolvedTheme } = useTheme();
    const Icon = resolvedTheme === "dark" ? ExampleDarkIcon : ExampleLightIcon;

    return <Icon {...props} />;
}
```

然后在 adapter 中注册 wrapper：

```ts
import { ExampleIcon } from "@/components/icons/database/example-icon";

export const DATABASE_ICONS = {
    // ...existing icons
    example: ExampleIcon,
} satisfies Record<string, DatabaseIconComponent>;
```

---

## 6. 接入已实现驱动配置

在对应 driver config 中引用 adapter 导出的稳定组件：

```tsx
import { Neo4jIcon } from "@/components/icons/database";
```

设置 `pickerIcon` 和 `treeVisual.icon`：

```tsx
export const neo4jDriverConfig: ExplorerDriverConfig<"neo4j"> = {
    driver: "neo4j",
    displayName: "Neo4j",
    pickerDescription: "连接到 Neo4j 图数据库",
    pickerIcon: Neo4jIcon,
    category: "graph",
    treeVisual: {
        icon: Neo4jIcon,
        iconClassName: "text-sky-500",
        badgeLabel: "N4",
        badgeClassName:
            "bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/20 dark:text-sky-300",
    },
    // ...
};
```

注意：

- `iconClassName` 用于尺寸、状态或文本色等外层样式；不要依赖它修复品牌图形内部填充。
- 如果图标本身已经带品牌色，多数情况下 `iconClassName` 的颜色类不会影响内部 path，这是预期行为。
- `treeVisual.badgeLabel` 仍由 driver config 维护，不属于图标 adapter。

---

## 7. 接入数据库选择窗口

`SelectDatabaseTypeDialog.tsx` 的静态列表使用 `iconKey` 读取品牌图标。新增数据库类型时，确保 `iconKey` 与 `DATABASE_ICONS` 中的 key 一致：

```ts
{
    driver: "neo4j",
    displayName: "Neo4j",
    iconKey: "neo4j",
    pickerDescription: "图数据库",
    category: "graph",
    isImplemented: true,
}
```

如果只是预留未实现驱动，也应尽量给出品牌图标：

```ts
{
    driver: null,
    displayName: "Neo4j",
    iconKey: "neo4j",
    pickerDescription: "图数据库",
    category: "graph",
    isImplemented: false,
}
```

实现驱动时，把对应项从占位状态改为真实驱动：

```ts
// 改造前
{ driver: null, iconKey: "neo4j", isImplemented: false, ... }

// 改造后
{ driver: "neo4j", iconKey: "neo4j", isImplemented: true, ... }
```

---

## 8. 删除旧资产或旧引用

替换旧图标后，检查是否还有手动 SVG 资产引用：

```powershell
Get-ChildItem -Recurse -File -Path src,docs -Include *.ts,*.tsx,*.md,*.css |
    Select-String -Pattern 'assets/database-icon|database-icon/'
```

如果没有引用，删除旧的 `src/assets/database-icon/*.svg` 文件。数据库品牌图标来源应统一收敛到 `src/components/icons/database/`。

---

## 9. 验证

每次新增或调整数据库图标后至少运行：

```bash
bun run tsc --noEmit
bun run build
```

人工检查：

- 数据库类型选择窗口中，已实现和未实现数据库都显示正确品牌图标。
- 连接树中，已实现驱动的连接节点显示正确品牌图标和 badge。
- 亮色主题下 MySQL 图标可见。
- 暗色主题下 MySQL 图标可见。
- 禁用态数据库卡片的 opacity 不会让图标完全不可辨认。

---

## 10. 常见问题

### 生成后的组件为什么还要手工规范化？

CLI 输出保留了部分原始 SVG 结构。React TSX 对 XML 声明、命名空间属性和字符串 style 更严格，所以要通过 `tsc` 发现并做机械修正。修正范围只限 React 兼容性和 `SVGProps` 透传，不应加入业务判断。

### 为什么不用 `@thesvg/icons` 运行时读取 variant？

当前驱动图标是编译期已知的品牌资产。CLI 生成组件更接近 shadcn 模式：无生产依赖、diff 可审查、TSX 可直接被现有 `ComponentType<SVGProps<SVGSVGElement>>` 类型消费。`@thesvg/icons` 更适合运行时 icon picker 或插件化动态 slug 场景。

### 为什么不直接用 `@thesvg/react`？

`@thesvg/react` 的组件使用默认 variant，不能直接选择 `light` / `dark`。MySQL 默认图标在亮色背景下可见性不符合当前 UI 需要，因此本项目采用 CLI 生成指定 variant 的方式。

### 可以使用 className 吗？

可以用于尺寸、布局和状态，例如 `className="size-5 opacity-60"`。不要用 className 改品牌图形内部颜色来弥补 variant 选择问题。
