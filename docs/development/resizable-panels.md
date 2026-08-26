# 踩坑笔记：`react-resizable-panels` 的 `setLayout` 与 `Layout` 对象键顺序

## 场景

在 `ResizablePanelGroup` 上使用 `groupRef` / `useGroupRef()`，在 `useEffect` 或 `useLayoutEffect` 里调用 `groupRef.current?.setLayout({ ... })`，从持久化 store 恢复左、中、右三栏的百分比宽度。

三栏在 JSX 中的顺序为：**左栏 → 中间 → 右栏**（例如 `leftPanel`、`centerPanel`、`agentPanel`）。

## 现象

- 调用 `setLayout` 后，**中间与右侧之间的拖动手柄**行为异常：鼠标往一侧拖，界面却往相反方向变化（方向「反了」）。
- 去掉 `setLayout` 后，拖动恢复正常。
- 将传入 `setLayout` 的对象 **改为按从左到右的视觉顺序书写属性**（先 `leftPanel`，再 `centerPanel`，最后 `agentPanel`）后，问题消失。

## 根因（为何键顺序会影响行为）

`Layout` 在类型上是「面板 id → 百分比」的映射，但 **`react-resizable-panels` 在校验与归一化布局时，并不是只按 id 查表**。

内部 `validatePanelGroupLayout` 会：

1. 使用 **`Object.values(layout)`** 得到一串数字，其顺序与 **`Object.keys(layout)` 的枚举顺序一致**（对普通字符串键，即对象字面量中 **属性的书写顺序**）。
2. 将这串数字与 **`panelConstraints` 数组按下标一一对应**（该数组顺序来自组内面板的注册/排序顺序，与从左到右的视觉顺序一致时，即为 左 → 中 → 右）。
3. 再按 **`Object.keys(layout)[index]`** 把处理后的值写回对象。

因此，**第 1 个数值会被当成「从左数第 1 块面板」的宽度，第 2 个数值当成第 2 块，以此类推**。若对象字面量写成：

```ts
{
  leftPanel: left,
  agentPanel: right,   // 实际是「右栏」的百分比
  centerPanel: center,
}
```

则 `Object.values` 为 `[left, right, center]`，库会误把 **右栏宽度配给中间栏、中间宽度配给右栏**，内部 flex 与视觉上的「中–右」分界不一致，拖动该手柄时就会表现为方向反转或其它错乱。

## 正确写法

传入 `setLayout`（以及若使用 `defaultLayout` 等同样走该校验路径的 API）时，**保证对象属性的书写顺序与面板在组内的从左到右顺序一致**：

```ts
groupRef.current?.setLayout({
  leftPanel: leftSidebarWidth,
  centerPanel: 100 - leftSidebarWidth - rightSidebarWidth,
  agentPanel: rightSidebarWidth,
});
```

不要依赖「只要 id 对就行」的直觉；在实现上，**键的顺序与数值顺序共同决定了与哪块面板对齐**。

## 补充说明

- 库在注册面板时还会用 `sortByElementOffset` 等按 DOM 几何排序；若首帧测量异常，也可能出现手柄行为怪异。本笔记所述为 **`Layout` 键序与 `Object.values`  zip 下标** 这一明确逻辑。
- 上游讨论「拖动方向反了」时，常见原因还包括缺省 `order`、嵌套布局等（见 [react-resizable-panels#232](https://github.com/bvaughn/react-resizable-panels/issues/232)）；与本笔记场景不同，可一并了解。

## 参考代码位置（本仓库）

- 使用处：`src/routes/main-layout.tsx`（`ResizablePanelGroup` + `setLayout` / `onLayoutChanged`）

## 库内实现（便于核对版本）

- `validatePanelGroupLayout`：`Object.values(layout)` 与 `panelConstraints` 按下标对齐；返回对象时用 `Object.keys(layout)[index]` 写回。

---

*整理自项目内实际踩坑与源码阅读，若升级 `react-resizable-panels` 大版本，建议重新核对 `validatePanelGroupLayout` 是否仍按相同规则处理。*
