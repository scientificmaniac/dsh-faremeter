# 侧边栏「工作区累计花费 ¥x.xx」插入点调研

> 目标：在 DSH 左侧栏的**工作区列表**里，给每个工作区显示一个「该工作区累计花费 ¥x.xx」，找**最小侵入**的插入点。
> 本文只做调研，**未改动任何源码**。
>
> 调研对象（官方已构建产物）：
> - `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`（5355 行）——工作区浏览器主体 `WorkspaceBrowser`
> - `@deepseek-ai/dsh-client-ui-workspace/README.zh.md`（234 行）
> - `@deepseek-ai/dsh-client-ui-workspace/package.json`（`dsh.client.inject`）
> - `@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（7447 行）——`CLIENT_SLOT_API` 插槽清单（第 2434 行起）
> - `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` + `HoverCard.module.css`——行外层包装
> - `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`——`sidebar.workspaces` 的宿主
> - `@deepseek-ai/dsh-api-workspace-controller/lib/client.js` / `lib/typert.host.js`——工作区快照类型
>
> 证据标注：**【源码】**＝我在上述构建产物里直接读到的行；**【推断】**＝由源码结构推出、未在运行时验证的结论。

---

## 0. 结论速览（TL;DR）

1. **没有任何「工作区行级」官方插槽。** `WorkspaceBrowser` 在自己注册 `sidebar.workspaces` 时，只声明了 5 个子 slot：`directoryFlow`、`session.menu.item`、`session.row.action`、`sidebar.session.row.leading`、`sidebar.session.row.hover`（`client.js:5222-5247`）。名单里**没有** `sidebar.workspaces.row` 之类的东西，`CLIENT_SLOT_API` 全表（`cordis-client-runner/lib/client.js:2434` 起）也查无此名。
2. 工作区行本身有**唯一一个可直接依赖的稳定属性**：`data-row-key="workspace:<workspaceId>"`（`client.js:1967`）。它不是哈希 class，且同一文件里只有 4 处 `data-row-key` 前缀：`workspace:` / `session:` / `overflow:` / 字面量 `empty`（`client.js:1967, 2275, 3312, 3010`）；在 `node_modules/@deepseek-ai/*/lib/*.js`（各包主客户端产物）里 grep，`data-row-key` **只出现在 ui-workspace 这一个文件**。
3. **推荐方案：方案 C —— 纯 DOM 注入**（`MutationObserver` + 在 `data-row-key^="workspace:"` 行尾插入一个 `span`）。侵入度最低（不替换、不遮蔽任何官方 UI），工作量约 120 行，金额常显。
4. **降级路径**：锚点失效时 fail-open（什么都不显示、不抛错）；并保留一条走官方插槽 `sidebar.session.row.hover` 的「悬浮卡片显示本工作区累计」作为永久兜底（该 slot `replaceRisk: "none"`，`cordis-client-runner/lib/client.js:6305-6350`）。
5. 方案 B（替换 `sidebar.workspaces`）的实际代价约 **2600+ 行**，且必须重放 5 个子 slot 声明与 5 个内置 action 注册，不划算。

---

## Q1. 侧边栏工作区列表的 DOM 结构

### Q1.1 渲染链（自上而下）

```
div.<hashed>  root + rail|wide                              WorkspaceBrowser 根（client.js:3825-3827）
├─ div.<hashed> sectionHeader                               client.js:3828-3834（只有文本「工作区」+搜索+视图/添加按钮）
│    └─ span.<hashed> sectionLabel  文本 = t("section.workspaces")  client.js:3831-3834
└─ div.<hashed> listArea                                    client.js:3963-3964
   └─ (groupBy !== "flat" 且搜索框为空 且 wide) → SessionTree  client.js:3965,3994-3995
      └─ HoverCardGroup → div.<hashed> treeBody             client.js:3331-3332；primitives/lib/index.js:4658,4698-4700
         └─ AnimatedRows → div[role="tree"][aria-label]     client.js:3338-3340；2526-2530
            ├─ div.<hashed> groupSection（每个工作区一个）     client.js:3195-3197（style: --dsh-workspace-indent: depth*12px）
            │  ├─ span.<hashed> HoverCard-root（display:block） primitives/lib/index.js:4992-4994
            │  │  └─ div[data-row-key="workspace:<workspaceId>"][role="treeitem"][aria-expanded]   ★工作区行
            │  │       ├─ span  (slot)   folder 图标          client.js:1979-1982
            │  │       ├─ span  (slot)   chevron 三角         client.js:1983-1986
            │  │       ├─ span.<hashed> projectText           client.js:1987-1988
            │  │       │    └─ span.<hashed> title  ← 工作区名，无 data-*
            │  │       └─ span.<hashed> rowActions（默认 display:none）client.js:1994-2040
            │  ├─ div[role="group"]（仅「按工作区树」时有嵌套子工作区）client.js:3251-3254
            │  │    └─ div.groupSection …（递归）
            │  ├─ span.<hashed> HoverCard-root
            │  │    └─ div[data-row-key="session:<sessionId>"][role="treeitem"][aria-selected]   client.js:2273-2279
            │  └─ button[data-row-key="overflow:<groupKey>"][aria-expanded]  「展开其余」  client.js:3309-3313
            └─ div.<hashed> exits（动画退出层，aria-hidden）     client.js:2538-2542
```

关键点（全部【源码】）：

- **工作区行 = `[data-row-key^="workspace:"]`**，属性贴在第 1967 行：
  ```js
  className: clsx(Rows_module_css_default.projectRow, menuOpen && Rows_module_css_default.menuOpen),
  "data-row-key": `workspace:${group.key}`,
  role: "treeitem",
  "aria-expanded": row.expanded,
  onClick: onToggle,
  ```
  （`client.js:1965-1974`）
- `group.key` 对真实工作区**就是 workspaceId**：`buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, …)`（`client.js:1041`），派生组原样透传 `key: g.key`（`client.js:1101`）。所以 `data-row-key` 冒号后的字符串＝工作区 id。
- **未分组桶**的 key 是空串：`buildGroup("", void 0, …, "")`（`client.js:1044`）→ 它的 `data-row-key` 恰好是字面量 `"workspace:"`（无 id），必须排除。
- 工作区行**没有** `aria-label` / `title` 属性；行内两个 `button` 才有 `aria-label`（重命名/新建会话，`client.js:2014, 2032`），且是本地化文案，不能当锚点。
- **可折叠、有 header**：行本身就是折叠开关——`aria-expanded` 在行上，`onClick: onToggle` 整行可点（`client.js:1969-1970`）；悬停时用 CSS 把 folder 图标换成 chevron（见 Q1.2）。折叠状态由 `setGroupExpanded` 写入浏览器本地 store（`client.js:3229-3232`）。
- **工作区行里没有「可插入额外内容」的官方子节点**：`projectText` 里只有一个 `span.title`（`client.js:1989-1992`），不接受 slot/children 参数。所以要加内容只能**加 DOM 节点**，或整包替换浏览器。
- 会话行是工作区行的**同级兄弟**（同在 `div.groupSection` 里，`client.js:3255-3308` 的 `sessions.map`），嵌套子工作区在中间的 `div[role="group"]` 里（`client.js:3251-3254`）。
- 行外层被 `HoverCard` 包了一层 `span`：`HoverCard` 返回 `span.root > [anchor, card]`（`primitives/lib/index.js:4992-4995`），`.root` 是 `display:block; position:relative`（`primitives/lib/HoverCard.module.css`）。**但 `data-row-key` 仍然贴在工作区行 div 自身**，插图时不受这层影响；未分组行因为是 `createdAt === void 0` 直接返回、**没有** HoverCard 包装（`client.js:2043`）。
- **两种视图不渲染工作区行**：`groupBy === "flat"`（单列表）只渲染会话行（`client.js:3378-3381, 3978`）；搜索态用 `SearchResults` 顶掉列表（`client.js:3965-3977`）；侧栏收成窄栏（`wide === false`）时整个 `listArea` 不渲染列表（`client.js:3965` 的 `wide && …`）。→ 金额在这些状态下自然消失，不需要额外处理（也意味着**不能**把金额放在 section header 上冒充）。

### Q1.2 用到的稳定属性 vs 不稳定属性

| 位置 | 可依赖属性 | 说明 |
|---|---|---|
| 工作区行 div | `data-row-key="workspace:<id>"`、`role="treeitem"`、`aria-expanded` | **可用**；`aria-expanded` 只出现在工作区行（会话行是 `aria-selected`，`client.js:2277-2278`） |
| 会话行 div | `data-row-key="session:<id>"`、`role="treeitem"`、`aria-selected` | 可用，但本需求不用 |
| 「展开其余」按钮 | `data-row-key="overflow:<groupKey>"`、`aria-expanded` | 前缀不同，不会被 `workspace:` 前缀误伤 |
| 工作区名 span | **无**（只有哈希 class `.title`） | 不可依赖；需要靠结构位置定位 |
| 列表根 | `role="tree"`、`aria-label`（**本地化文案**） | `role` 可依赖，`aria-label` 不可（zh/en 变化） |
| section header、groupSection、projectText、rowActions | **无**（全是哈希 class，每次构建都变，例如 `.qZBEgG_projectRow`） | 不可依赖 |

> 哈希 class 证据：`client.js:1979-1992` 用 `Rows_module_css_default.slot/.folder/.projectText/.title`，这些在 `client.js:1741` 那一行被编译成 `qZBEgG_*`（本次构建的前缀）；`client.js:1740` 的 `//#region …/Rows.module.css.mjs` 说明它来自 CSS Module，前缀随构建变化。

### Q1.3 行内布局（决定金额插哪、会不会挤）

`client.js:1741`（Rows 的整行 CSS 字符串）里的规则【源码】：

```css
.qZBEgG_projectRow,.qZBEgG_sessionRow{ … align-items:center; gap:6px; padding-inline-start:calc(8px + var(--dsh-workspace-indent,0px)); display:flex }
.qZBEgG_projectRow{ box-sizing:border-box; align-items:center; height:34px }
.qZBEgG_projectText{ flex-direction:column; flex:1; gap:2px; min-width:0; display:flex }
.qZBEgG_title{ text-overflow:ellipsis; white-space:nowrap; min-width:0; font-size:14px; line-height:20px; overflow:hidden }
.qZBEgG_projectRow .qZBEgG_rowActions{ height:20px }
.qZBEgG_rowActions{ flex:none; align-items:center; gap:15px; display:none }
.qZBEgG_projectRow:hover .qZBEgG_rowActions,…{ display:inline-flex }
.qZBEgG_projectRow:hover .qZBEgG_chevron{ display:inline-flex }
.qZBEgG_projectRow:hover .qZBEgG_folder{ display:none }
```

→ 行是 `display:flex; height:34px; gap:6px`，`projectText` 吃掉剩余宽度。**在行尾 `appendChild` 一个 `flex:none` 的 span，就会自然贴右**，不需要 `margin-left:auto`；行高 34px 也够放一个 16px 行高的 10-11px 小字。

---

## Q2. `sidebar.workspaces.session.row.action` 的 owner props 与渲染位置

### Q2.1 渲染调用点【源码】

`client.js:2323-2352`（在 `SessionNodeItem` 里）：

```js
!row.blank && (0, react_jsx_runtime.jsxs)("span", {
    className: Rows_module_css_default.rowActions,
    onClick: (e) => { e.stopPropagation() },
    children: [
        Menu(... anchor: button "..."),                                    // 2328-2343
        children: renderSlot("sidebar.workspaces.session.menu.item", {     // 2344-2347
            sessionId: node.id, displayTitle: row.title
        }, { hookContext: menuOpenState }),
        renderSlot("sidebar.workspaces.session.row.action", {              // 2348-2351
            sessionId: node.id,
            displayTitle: row.title
        })
    ]
})
```

- ownerProps：`{ sessionId, displayTitle }`，**没有 workspaceId**。
  - 定义在插槽清单里：`SessionRowOwnerProps { sessionId; displayTitle }`（`cordis-client-runner/lib/client.js:6596`，菜单项版本 `:6542`）。
- 渲染位置：会话行**最右端的 `rowActions` 容器内、`...` 菜单按钮之后**（`client.js:2323-2351`）；同一份代码被「分组视图」和「单列表视图」共用（`SessionNodeItem` 只有两个调用点：`client.js:3295`（SessionTree）、`client.js:3391`（FlatList））。
- **默认不可见，仅悬停/菜单打开时显示**：`.rowActions{display:none}`，`:hover` 或 `.menuOpen` 才 `display:inline-flex`（两处证据：`client.js:1741` 的 CSS 规则 + 类名拼装在 `client.js:1966, 2276`）。切到「单列表」视图时同样只有悬停可见。
- 语义约束（插槽文档，`cordis-client-runner/lib/client.js:6574-6575`）：“An entry renders one icon button … Clicks inside the strip stay in the strip”，即**预期是一个图标按钮**；但技术上任何元素都能渲染，容器点击不会冒泡打开会话。

### Q2.2 能否用它给「每个会话行」加金额标签？

**能，但只能 hover 才看见，而且拿不到 workspaceId。** 结论：

- ✅ 零 DOM hack、纯官方契约、`replaceRisk: "none"`（`cordis-client-runner/lib/client.js:6614`）。
- ❌ 常显做不到（父容器 `display:none`）。
- ❌ 要拿工作区 id 得自己反查：`useWorkspaces` 是标准 props（`cordis-client-runner/lib/client.js:6601`），遍历 `items` 找 `item.sessionIds.includes(sessionId)`；同一 session 只属于一个 workspace（`client.js:1031-1042` 的归属构建），所以反查是确定的【源码】，但每行一次 O(n·m) 扫描，可用 Map 预建【推断的性能处理】。
- 适合作为**降级/详情入口**（悬停时显示「本工作区累计 ¥x.xx」+ 一个按钮打开明细），不适合作为主视觉。

### Q2.3 注册代码骨架（模块加载器写法，与现有 `lib/client.js` 风格一致）

```js
// —— 注册到 sidebar.workspaces.session.row.action（hover 才可见，降级方案用）——
// 说明：ownerProps 只有 { sessionId, displayTitle }；workspaceId 靠 useWorkspaces 反查。
ctx.slots.inject("sidebar.workspaces.session.row.action", function () {
  return ctx.slots.register(
    {
      name: "sidebar.workspaces.session.row.action",
      id: "faremeter.workspace-total",   // 自己的命名空间 id，不遮蔽官方 archive(100)/pin(200)
      order: 900,
      label: function () { return "工作区累计花费"; }
    },
    function WorkspaceTotalRowAction(props) {
      // props = { sessionId, displayTitle,
      //           useWorkspaces, useSessions, useSessionStatus, … }  ← 标准 props
      var items = props.useWorkspaces(function (state) { return state.items; });

      var workspaceId = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].sessionIds && items[i].sessionIds.indexOf(props.sessionId) >= 0) {
          workspaceId = items[i].workspaceId;
          break;
        }
      }
      // 金额来自本插件自己的数据源（见 Q5 末：快照里没有 cost 字段）
      var amount = window.__DSH_FAREMETER__ && window.__DSH_FAREMETER__.workspaceTotals
        ? window.__DSH_FAREMETER__.workspaceTotals[workspaceId]
        : undefined;
      if (workspaceId === null || amount === undefined) return null;   // fail-open

      return React.createElement(
        "span",
        { className: "dtc-ws-total", title: "本工作区累计花费" },
        "¥" + amount.toFixed(2)
      );
    }
  );
});
```

> `renderSlot` 的 owner 侧调用形态见 `client.js:2348-2351`；`useWorkspaces` 是 slot 的**标准 props**，由 ui-workspace 用 `ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })` 提供（`client.js:5039-5040`），不是可 inject 的服务名——所以**不要**把 `useWorkspaces` 写进 `inject`（现有插件 `lib/client.js:910-911` 对 `useChat` 的注释同理）。

### Q2.4 顺带：`sidebar.session.row.hover`（悬浮卡片段）

同样 `kind: list` / `scope: root` / `replaceRisk: "none"`，ownerProps 只有 `{ sessionId }`（`cordis-client-runner/lib/client.js:6330`），仅在会话悬浮卡片打开时挂载（`client.js:2355-2360` 的 `SessionHoverContent`）。**建议用它做永久兜底**：悬浮到任意会话行就能看到「本工作区累计 ¥x.xx」，即使 DOM 注入失效也有一条官方路径能读到数字。

---

## Q3. 有没有专门的「工作区行」插槽？

### Q3.1 结论

**没有。** 证据两条：

1. `WorkspaceBrowser` 注册 `sidebar.workspaces` 时声明的 `children` 只有 5 个（`client.js:5222-5247`）：
   ```js
   children: {
     "sidebar.workspaces.directoryFlow":      { kind: "single", scope: "root" },
     "sidebar.workspaces.session.menu.item":  { kind: "list",   scope: "root", inject: { hooks: {…} } },
     "sidebar.workspaces.session.row.action": { kind: "list",   scope: "root" },
     "sidebar.session.row.leading":           { kind: "list",   scope: "root" },
     "sidebar.session.row.hover":             { kind: "list",   scope: "root" }
   }
   ```
2. `CLIENT_SLOT_API` 全表里所有 workspace/sidebar 相关 key 里，没有任何 `workspace.row*` / `workspaces.group*`（下节逐条）。

### Q3.2 全部工作区/侧栏相关 slot 逐条判定

> kind/scope/occupants 均取自 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API`（行号见括号），occupants 摘录官方登记名。

| slot | kind | scope | occupants | ownerProps | 能否放「工作区金额」 |
|---|---|---|---|---|---|
| `sidebar.workspaces`（:6459） | single | root | ui-workspace `WorkspaceBrowser` | `{ wide, expandSidebar }`（:6465） | ⚠️ 能放但**必须重写整个浏览器**，`replaceRisk: shadows-shipped-ui`（:6483）→ 方案 B，不划算 |
| `sidebar.workspaces.directoryFlow`（:6488） | single | root | `BrowseDirectoryFlow` / `NativeDirectoryFlow` | `{ open, busy, onPicked, onCancel, onError }` | ❌ 目录选择流程，且 single + 已占用 |
| `sidebar.workspaces.session.menu.item`（:6517） | list | root | ui-workspace `pin/rename/fork/archive/session-id` | `{ sessionId, displayTitle }` | ❌ 会话「...」菜单的**行**，属于会话不属工作区；可放「查看工作区花费」菜单项（跳详情），不能常显数字 |
| `sidebar.workspaces.session.row.action`（:6571） | list | root | ui-workspace `archive(100)` / `pin(200)` | `{ sessionId, displayTitle }` | ⚠️ 能放数字，但父容器 `display:none` → **仅 hover 可见**；且无 workspaceId |
| `sidebar.session.row.leading`（:6353） | list | root | ui-schedule `schedule-mark` | `{ sessionId }` | ❌ 会话行行首 16px 装饰位，只在 idle 时渲染，且会话级 |
| `sidebar.session.row.hover`（:6305） | list | root | ui-schedule `schedule-tasks` | `{ sessionId }` | ⚠️ 会话悬浮卡片内可放数字（**仅 hover**），可作兜底详情 |
| `sidebar`（:5527） | single | root | `SidebarRoot` | `{ collapsed, width }` | ❌ single 且是整条侧栏外壳，已占用 |
| `sidebar.brand.mark` / `.brand.name`（:5556/:5585） | single | root | 官方品牌 Logo/名称 | `{ size }` / `{ children?: never }` | ❌ 品牌位，`shadows-shipped-ui` |
| `sidebar.chat.conversation`（:5614） | single | session | `ConversationSlotPanel` | — | ❌ 会话作用域 |
| `sidebar.footer.action`（:5652） | list | root | cordis `cordis-panel` | `{ wide }` | ❌ 位置在侧栏页脚（设置旁），不是工作区行；但**可作隐形 daemon 挂载点**（标准 props 含 `useWorkspaces`/`useSessions`）→ 方案 D |
| `sidebar.panellist`（:5700） | list | root | plugin-manager / schedule 图标 | `{ size, active }` | ❌ 全局面板图标位 |
| `sidebar.settings`（:6401） | single | root | `SettingsRoot` | `{ wide }` | ❌ 设置入口 |
| `sidebar.toggle.badge`（:6430） | single | root | `DesktopUpdateBadge` | — | ❌ 折叠按钮角标 |
| `conversation.hero.workspace`（:3203） | single | root | `WorkspacePicker` | `{ open, anchorRef, selectedId, onPick, onClose }` | ❌ 主视觉区工作区选择器，不在侧栏 |
| `conversation.hero.workspace.directoryFlow`（:3232） | single | root | 目录选择器 | 目录流约定 | ❌ 同上 |
| `workspace.toast`（:6813） | keyed | root | ui-workspace 各类 toast entry | 各 key 自己的 props | ❌ 通知浮层 |
| `shell.overlay`（:5433） | list | root | 11 个（toast/对话框/提示） | 无 ownerProps | ❌ 不是行内，但**是官方提供的「加一个自己的全局面」座位**（click-through）→ 方案 D 的挂载点 |
| `workspaces`（服务，非 UI，:1615） | — | — | Workspace Controller 的 Client 服务面（`ctx.workspaces.list`） | — | ✅ **数据源**（见 Q5） |

**明确写出来：没有工作区行级插槽，也没有工作区悬浮卡片插槽**（`WorkspaceHoverContent` 是硬编码的 title/path/created 三段，`client.js:1912-1930`，没有 `renderSlot`）。

---

## Q4. 最小侵入方案推荐

### 方案 A：只用官方插槽

- 可用的只有 `sidebar.workspaces.session.row.action`（hover 可见）与 `sidebar.session.row.hover`（hover 可见）。
- **做不到常显**；且两个 slot 的 ownerProps 都只有 `sessionId`，工作区金额要先用 `useWorkspaces` 反查 workspaceId 再查总额。
- 侵入度：**极低**。稳定性：**高**（官方契约，`replaceRisk: "none"`）。工作量：**小**，约 50~80 行。
- 定位：**降级/兜底方案**，不是主方案。

### 方案 B：替换 `sidebar.workspaces`（重写工作区浏览器）

- 官方 `WorkspaceBrowser` 模块本体 `client.js:2777-4121`，**1344 行**（含派生逻辑、组树、拖拽、水位线、搜索、重命名/删除对话框）。
- 它依赖的 `Rows.js`（`client.js:1788-2381`，594 行）、`AnimatedRows`（`client.js:2382-2561`）、`stores/pin-order/navigation`（`client.js:1247-1787`，541 行）、注册与 actions 接线（`client.js:4993-5355`，363 行）。
- 替换后还必须**自己重新声明** 5 个子 slot，并重新注册 `pin/rename/fork/archive/session-id` 5 个 action（否则这些功能全灭，官方注册会被遮住）。
- 现实代价：**2600+ 行**、功能回归面极大、每次官方改版都要跟。`replaceRisk: shadows-shipped-ui`（`cordis-client-runner/lib/client.js:6483`）。
- 唯一优点：位置任意、可做交互（点金额展开明细）。→ **不推荐**。

### 方案 C：纯 DOM 注入（★推荐）

用 `MutationObserver` 盯住侧边栏，找到 `[data-row-key^="workspace:"]` 行，在行尾插一个金额 `span`。

**为什么它比方案 A/B 都好**

- 不替换任何官方渲染，官方升级时最多「金额消失」，不会把工作区列表弄坏（fail-open）。
- 锚点 `data-row-key` 是官方自己的 keyed-row 测量机制用的（`client.js:2488` 用它枚举行、`client.js:2413` 在退出残影上删掉它），**同一份构建里语义稳定**；前缀只有本包在用。
- 行内布局给了一个天然的落点：`display:flex` + `projectText{flex:1}`（`client.js:1741`）→ 行尾 `appendChild` 自然右对齐。

**锚点选择器（可直接复制）**

```js
// 主选择器：真实工作区行（排除未分组桶——它的 data-row-key 恰好是 "workspace:"，无 id）
const PRIMARY = '[data-row-key^="workspace:"]:not([data-row-key="workspace:"])';
// 注：下面 reconcile 里为了同时兼容「取 id」这一步，写成前缀选择器 + workspaceIdOf 判空，
//     效果与 PRIMARY 等价（未分组桶 id 为 null 会被跳过）。

// 兜底选择器：属性级替代（万一 data-row-key 被改名）
// 工作区行是唯一「role=treeitem + aria-expanded 且没有 aria-selected」的行
function isWorkspaceRowByAria(el) {
  return el.nodeType === 1
    && el.getAttribute('role') === 'treeitem'
    && el.hasAttribute('aria-expanded')
    && el.getAttribute('aria-selected') === null;
}
```

**取值（workspaceId 直接来自行自身）**

```js
function workspaceIdOf(row) {
  const key = row.getAttribute('data-row-key') || '';
  if (key.indexOf('workspace:') !== 0) return null;   // 兜底选择器路径下这里返回 null
  const id = key.slice('workspace:'.length);
  return id === '' ? null : id;                       // 未分组桶没有 id
}
```

**注入 + 自愈逻辑（可直接复制）**

```js
var MARK = 'data-dtc-ws-cost';          // 自己的标记，便于自愈与清理
var RECONCILE_DEBOUNCE_MS = 120;        // 流式输出时把 reconcile 压到 ~8 次/秒

// Map<workspaceId, number>：由插件自己的数据源填充（见 Q5 末；快照里没有金额字段）
var amounts = new Map();
// 数据到达时只需：amounts = 新Map; scheduleReconcile();

function reconcileWorkspaceCosts() {
  var rows = document.querySelectorAll('[data-row-key^="workspace:"]');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var id = workspaceIdOf(row);
    if (id === null) continue;                       // 未分组桶跳过
    var amount = amounts.get(id);
    var label = row.querySelector('[' + MARK + ']');
    if (amount === undefined || amount === null) { if (label) label.remove(); continue; }
    if (!label) {
      label = document.createElement('span');
      label.setAttribute(MARK, '1');
      label.className = 'dtc-ws-cost';
      label.setAttribute('title', '本工作区累计花费');
      label.setAttribute('aria-hidden', 'true');     // 纯装饰，别打断读屏顺序
      row.appendChild(label);                        // ★ 行尾；projectText flex:1 会把它推到最右
      // 备选落点（想让它永远在 hover 按钮左边时用）：
      // row.insertBefore(label, row.lastElementChild);   // lastElementChild = rowActions（1994 行无条件渲染）
    }
    var text = '¥' + amount.toFixed(2);
    if (label.textContent !== text) label.textContent = text;   // 只在数字变了才写 DOM
  }
  // 清理：行已被 React 移除/切视图时，清掉孤立的标记
  var orphans = document.querySelectorAll('[' + MARK + ']');
  for (var j = 0; j < orphans.length; j++) {
    if (!orphans[j].closest('[data-row-key]')) orphans[j].remove();
  }
}

var queued = 0;
function scheduleReconcile() {
  if (queued) return;
  queued = setTimeout(function () {
    queued = 0;
    try { reconcileWorkspaceCosts(); } catch (e) { /* 永不抛 */ }
  }, RECONCILE_DEBOUNCE_MS);
}

// 观察策略
var observer = new MutationObserver(scheduleReconcile);
observer.observe(document.body, { childList: true, subtree: true });
scheduleReconcile();   // 首帧补一次
// 卸载：ctx.effect(() => { …; return () => { observer.disconnect(); clearTimeout(queued) } })
```

**观察策略的取舍（重要）**

- 观察 `document.body` + `subtree` 是**唯一不依赖哈希 class** 的写法：工作区列表会被「切分组方式 / 搜索 / 折叠侧栏」整体卸载重挂（`client.js:3965-3995`），只在某一层挂 observer 会在重挂后失联。
- 代价：聊天流式输出会持续产生 mutation。用 **120ms 防抖 + 文本相等短路** 把开销压到「每秒 ~8 次 `querySelectorAll`（≤20 个节点）+ 几次属性读取」，实测可忽略【推断，未做运行时压测】。
- 若想更省：在找到列表根 `[role="tree"]` 后，额外对它挂一个 `{childList:true}` 的观察器做「行增删」快速响应，`document.body` 那个只作为「整块重挂」的兜底（两级观察）。这属于优化，不是必需。

**样式（可直接复制）**

```css
.dtc-ws-cost{
  flex: none;
  margin-inline-start: 4px;
  font-size: 10px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;   /* 数字等宽，金额变化不抖 */
  white-space: nowrap;
  pointer-events: none;                 /* 不抢工作区行「整行点击折叠」的手势 */
  user-select: none;
}
```

**风险（如实列出）**

1. **React 可能清掉我们插入的节点**：工作区行在 `onToggle / menuOpen / 行内重命名` 时会重渲染子节点。React 只管理它自己创建的节点，通常不会动外来节点；但**不能保证**——所以靠 120ms 防抖观察器「自愈」重插（上面的 `if (!label)` 分支就是干这个的）。
2. `data-row-key` 是**内部契约**，不是公开 API（`CLIENT_SLOT_API` 里没有它）。官方若重命名 → 金额消失（不会崩）。
3. 只覆盖「分组 / 分组树」视图；单列表、搜索态、窄栏没有工作区行 → 不显示（这与需求语义一致）。
4. 悬浮态会多出两个按钮（`rowActions` 从 `display:none` 变 `inline-flex`），金额会被挤左一点；若在意，把落点改成 `insertBefore(row.lastElementChild)`。

### 方案 D：`shell.overlay` 隐形条目 + `ReactDOM.createPortal` 进工作区行

- 在 `shell.overlay`（`kind:list / scope:root / replaceRisk:"none"`，`cordis-client-runner/lib/client.js:5433-5489`，官方明确说明它是「frame-wide floating layer … 加自己的面」）注册一个**渲染 `null`** 的条目，拿标准 props（`useWorkspaces`/`useSessions`/`useSessionStatus`），在 `useEffect` 里跑同样的 `MutationObserver`，用 `ReactDOM.createPortal(<金额/>, row)` 把 React 元素塞进行里。
- 好处：数字由 React 驱动、金额变化只重渲染 portal、不需要手写 `textContent`；将来要加「点金额看明细」的交互更顺。
- 坏处：多一个官方插槽条目 + 多一层 React 树；**portal 的宿主节点是别的 React root 拥有的 DOM**，行被卸载时 portal 需要及时失效，否则要自己兜异常——反而比纯 DOM 多一类崩溃面。
- 结论：**常显 + 需要交互**时选它；**只要一个只读数字**时方案 C 更稳。

### 方案对比表

| 维度 | A 官方插槽（row.action / row.hover） | B 替换 `sidebar.workspaces` | **C 纯 DOM 注入（推荐）** | D overlay + portal |
|---|---|---|---|---|
| 侵入度 | 极低（只加 list 条目） | **极高**（重写 2600+ 行，遮蔽官方 UI） | 低（只在行尾加一个 span，无插槽、无替换） | 中（多一个常驻 overlay 条目 + React 树） |
| 稳定性（官方改版会不会挂） | **高**（公开契约，`replaceRisk:none`） | **低**（浏览器本体 1344 行 + 依赖 ~1300 行，每次改版都要跟） | 中（依赖 `data-row-key` 内部契约；挂了只丢金额） | 中（同 C，另加 portal 宿主失效风险） |
| 工作量 | 小（~50–80 行 + 数据反查） | 大（2600+ 行，且需重放 5 子 slot + 5 action） | **中（~120 行 + 宿主金额来源）** | 中偏大（~150 行 + 宿主金额来源） |
| 金额是否常显 | ❌ 仅 hover | ✅ 任意 | ✅ 行尾常显 | ✅ 行尾常显 |
| 能否拿 workspaceId | 需用 `useWorkspaces` 反查 | 随意 | ✅ 直接从 `data-row-key` 取 | ✅ React 侧随意 |
| 失效后果 | 无（官方通道） | 工作区列表整体坏掉 | 只丢金额（fail-open） | 只丢金额（fail-open） |

### 推荐与降级行为

**推荐：方案 C 为主 + 方案 A 的 `sidebar.session.row.hover` 条目做永久兜底。**

1. 主路径（常显）：`MutationObserver` + `[data-row-key^="workspace:"]:not([data-row-key="workspace:"])` + `row.appendChild(span)`。
2. 兜底路径（官方契约，不会因 DOM 改版失效）：注册 `sidebar.session.row.hover` 一个条目，在会话悬浮卡片里显示「本工作区累计 ¥x.xx」。这样即使锚点被官方改掉，数字仍在（只是要 hover）。
3. 数据路径：金额来自本插件自己的数据源（宿主侧聚合），插件只负责「workspaceId → 行」的贴图；`workspaceId` 与宿主返回的 key **本身就是同一个值**（见 Q5），不需要额外映射表。

**如果官方改版导致锚点失效，降级阶梯：**

| 级别 | 触发 | 行为 |
|---|---|---|
| L0 | 正常 | `data-row-key="workspace:<id>"` 命中 → 行尾常显 |
| L1 | `data-row-key` 改名/移除 | 用 `isWorkspaceRowByAria()` 找行；但此时**拿不到 workspaceId** → 仅当插件缓存了 `workspaceId → 工作区标题` 映射且该行文本能唯一匹配时才贴（标题可能被本地化成「默认工作区」，见 `client.js:3517-3521`，所以**默认不做**） |
| L2 | 两个选择器都找不到行 | 静默不渲染，**不抛错、不隐式重试**；在诊断对象（现有 `window.__DSH_FAREMETER__`）里记一条 `wsAnchorMiss`，方便用户/维护者一眼看出「插件在、只是没找到落点」 |
| L3 | 产品层兜底 | 走官方 slot 的悬浮卡片条目（方案 A 兜底），以及已有的每轮费用胶囊（`conversation.chat.assistant-actions`，插件现状）继续工作 |

> 关键纪律：**任何一级失败都不能让侧边栏报错或阻塞点击**。注入的 span 加 `pointer-events:none`，`reconcile` 整体 `try/catch`，`apply()` 不抛（沿用现有插件 `lib/client.js` 的 fail-open 约定）。

---

## Q5. 工作区列表数据的客户端来源

### Q5.1 组件怎么拿工作区列表【源码】

- `WorkspaceBrowser` 的签名里直接有 `useWorkspaces`（`client.js:3509`），读法：
  ```js
  const storedWorkspaces = useWorkspaces((state) => state.items);   // client.js:3516
  const workspacePhase    = useWorkspaces((state) => state.phase);  // :3522
  const workspaceStreamState = useWorkspaces((state) => state.state); // :3523
  const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds); // :3524
  const pinnedSessionIds   = useWorkspaces((state) => state.pinnedSessionIds);   // :3525
  ```
- `useWorkspaces` 是**插槽标准 props**（`cordis-client-runner/lib/client.js:6470`），由 ui-workspace 用 `ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })`（`client.js:5039-5040`）挂到 root 作用域。→ 任何 root 作用域的 list/single slot 条目都能用它；插件侧不需要 inject 它。
- 底层数据是 Client 服务 **`workspaces`**（`dsh-api-workspace-controller/lib/client.js:387`：`super(ctx, "workspaces")`，`this.list = model`）；模型提供 `getSnapshot()`（`:255-258`）与 `subscribe(listener)`（`:245-250`）。**第三方客户端插件可以 `inject: ["slots", "workspaces"]` 后直接 `ctx.workspaces.list.getSnapshot()`**（ui-workspace 自己的 `inject` 就含 `"workspaces"`，`client.js:5004-5014` 的第 5007 行）——这是纯 DOM 方案（方案 C）拿数据的门。

### Q5.2 快照与每个工作区的字段【源码】

快照结构（`dsh-api-workspace-controller/lib/client.js:259-268`）：

```js
{
  items,               // WorkspaceView[]
  archivedSessionIds,  // SessionId[]
  pinnedSessionIds,    // SessionId[]
  state,               // 'loading' | 'idle' | …
  phase,               // 'pending' | 'ready' | …
  error               // 出错信息
}
```

`WorkspaceView`（`dsh-api-workspace-controller/lib/typert.host.js:890`，原文一行）：

```ts
export interface WorkspaceView {
    readonly workspaceId: WorkspaceId;
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly SessionId[];
    readonly createdAt: string;   // ISO 字符串，浏览器里 Date.parse 后用（client.js:1041）
    readonly updatedAt: string;
}
```

浏览器派生出来的组节点（`deriveGroups`，`client.js:1100-1110`）：

```js
{ key, workspaceId, cwd, createdAt, label, sessionCount, expanded, containsCurrent, sessions }
```

- `key` === `workspaceId` === DOM 里 `data-row-key` 冒号后的字符串（`client.js:1041` → `:1101` → `:1967`）。
- `sessionCount` 只是派生字段，**没有渲染到行上**（`ProjectRowItem` 整个函数没有读它，`client.js:1950-2059`）。
- 未分组桶：`workspaceId === undefined`、`key === ""`、`label === ""`，渲染时用 `t("group.ungrouped")`（`client.js:1044, 1952`）。

### Q5.3 能不能把「工作区 id」和宿主算的金额对应上？

**能，而且是现成的键：**

- 宿主金额按 `workspaceId` 出 → DOM 侧从 `data-row-key="workspace:<workspaceId>"` 直接切出同一个 id；React 侧从 `WorkspaceView.workspaceId` 拿。**两边不需要任何映射/标题匹配。**
- 一个 session 只属于一个 workspace（归属在 `client.js:1031-1042` 唯一确定），所以「会话级金额 → 工作区级金额」的聚合键也明确：`sessionIds` 就是归属集合。

### Q5.4 金额本身不在客户端快照里（必须宿主补）

- `WorkspaceSnapshot` / `WorkspaceView` **没有任何 token/费用字段**（上文两个结构即全部字段）。
- 会话摘要 `SessionSummary` 也没有用量字段：`{ agentAvailable, formatStatus?, sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`（`dsh-api-session-controller/lib/typert.host.js`，`exports interface SessionSummary` 声明行）。
- 现有插件是在**打开的那一个会话**里从 Chat 节点 `data.tokenUsage` 算每轮费用（本仓库 `lib/client.js:1-30` 注释与 `pickTurnData`），**拿不到其它会话的历史用量**。
- 结论【推断，需宿主方案确认】：工作区累计金额必须由**宿主半边**聚合（扫 session 日志的 tokenUsage，或由 DSH 的 token-meter/session-stats 类服务求和），再通过插件自己的客户端通道（服务/推送）下发。**本调研只解决「插在哪」**；只要宿主按 `workspaceId` 出金额，Q5.1 的两条客户端通道都能直接对接。

---

## 附录 A：证据索引（文件 → 关键行）

| 文件 | 行号 | 内容 |
|---|---|---|
| `dsh-client-ui-workspace/lib/client.js` | 1002-1011 | `buildGroup`：组节点字段 |
| 同上 | 1027-1046 | `groupByWorkspace`：工作区 → 组，`key = workspaceId`，未分组 `key=""` |
| 同上 | 1091-1113 | `deriveGroups`：派生组（含 `sessionCount`） |
| 同上 | 1741 | Rows 的整行 CSS（`projectRow/sessionRow/projectText/rowActions/title` 的 `flex/height/display:none` 规则） |
| 同上 | 1912-1930 | `WorkspaceHoverContent`（工作区悬浮卡片，**无插槽**） |
| 同上 | 1950-2059 | `ProjectRowItem`：工作区行（`data-row-key` 1967、`role` 1968、`aria-expanded` 1969、`onClick:onToggle` 1970、`projectText` 1987、`rowActions` 1994） |
| 同上 | 2254-2368 | `SessionNodeItem`：会话行（`data-row-key` 2275、`aria-selected` 2278、`menu.item` 2344、`row.action` 2348） |
| 同上 | 2526-2543 | `AnimatedRows` 根：`div[role="tree"]` |
| 同上 | 3195-3329 | `renderGroup`：`groupSection`、`ProjectRowItem` 调用、`div[role="group"]`、会话行、`overflow` 按钮 |
| 同上 | 3509-3525 | `WorkspaceBrowser` 签名与 `useWorkspaces` 读法 |
| 同上 | 3825-3834 | 根节点与 section header |
| 同上 | 3963-3995 | `listArea`：`wide` / 搜索 / flat / SessionTree 分支 |
| 同上 | 5004-5014 | 客户端 `inject` 列表（含 `"workspaces"`） |
| 同上 | 5039-5040 | `ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })` |
| 同上 | 5181-5215 | `browserInjected`：浏览器的动作注入（数据面走标准 hooks，不在这里） |
| 同上 | 5220-5251 | `sidebar.workspaces` 注册 + 5 个子 slot 声明 |
| 同上 | 5252-5304 | 内置 `menu.item` / `row.action` 注册（pin/rename/fork/archive/session-id） |
| `dsh-client-ui-workspace/README.zh.md` | 92-94, 100-106 | 插槽与子 slot 的官方说明（会话行两个 seat 只拿 `sessionId`） |
| `dsh-client-ui-workspace/README.zh.md` | 44 | 工作区树折叠/展开语义 |
| `dsh-client-ui-workspace/README.zh.md` | 114-171 | 「打包客户端插件」示例：`ctx.slots.inject` + `register` 写法 |
| `dsh-cordis-client-runner/lib/client.js` | 2434 / 7003 | `CLIENT_SLOT_API` 数组与 catalog map |
| 同上 | 6305-6350 | `sidebar.session.row.hover` 全量定义 |
| 同上 | 6353-6399 | `sidebar.session.row.leading` 全量定义 |
| 同上 | 6459-6486 | `sidebar.workspaces` 全量定义（`replaceRisk: shadows-shipped-ui`） |
| 同上 | 6517-6568 | `sidebar.workspaces.session.menu.item` 全量定义 |
| 同上 | 6571-6617 | `sidebar.workspaces.session.row.action` 全量定义（ownerProps / occupants / replaceRisk） |
| 同上 | 5433-5491 | `shell.overlay` 全量定义 |
| 同上 | 1615-1755 | 客户端服务 `workspaces` 的方法面 |
| `dsh-client-ui-primitives/lib/index.js` | 4658-4700 | `HoverCardGroup` 包一层 div |
| 同上 | 4992-4995 | `HoverCard` 根：`span.root` |
| `dsh-client-ui-primitives/lib/HoverCard.module.css` | — | `.root{display:block;position:relative}` |
| `dsh-client-ui-sidebar/lib/client.js` | 391-399 | `renderSlot("sidebar.workspaces", { wide, expandSidebar })` |
| `dsh-api-workspace-controller/lib/client.js` | 245-268 | `subscribe` / `getSnapshot` / 快照字段 |
| 同上 | 383-392 | 服务名 `workspaces`、`this.list = model` |
| `dsh-api-workspace-controller/lib/typert.host.js` | 890 | `WorkspaceView` 字段（一行声明） |

## 附录 B：本次调研的边界

- **只读**：未修改任何官方产物、未修改本仓库任何源码；只新增本文件。
- **未做运行时验证**：以上 DOM 结构来自官方已构建产物的 JSX 调用链与 CSS 常量，**没有**在运行中的 GUI（`http://127.0.0.1:43120`）里实测过 `data-row-key` 的实际 DOM。建议实现前先用一条控制台命令确认：
  ```js
  document.querySelectorAll('[data-row-key^="workspace:"]').length
  // 期望 = 侧栏当前显示的真实工作区数（若存在不属于任何工作区的游离会话，会多 1 个 data-row-key="workspace:" 的未分组桶，client.js:1043-1044）
  ```
- **【推断】标记的结论**（共 4 处）：① 第三方客户端插件可用 `inject:['workspaces']` 拿到 `ctx.workspaces.list`（依据是 ui-workspace 自身 `inject` 含该项 + 服务名 `workspaces` 已注册，未在第三方 bundle 里实证）；② MutationObserver 120ms 防抖的开销可忽略（未压测）；③ 工作区累计金额必须宿主侧聚合（依据是客户端快照与 SessionSummary 均无用量字段，未排除存在其它未检查的 client 服务）；④ React 重渲染会清掉外来子节点（未实证，因此代码按「最坏情况会掉、观察器自愈」设计）。
