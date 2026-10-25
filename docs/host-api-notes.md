# 宿主侧 API 调研笔记（会话累计费用 · 按工作区聚合）

> 调研目标：为「统计会话累计费用、按工作区聚合费用」的插件，摸清 DSH 宿主端可用 API 与数据格式。
> 本文**只做调研**，不涉及任何源码改动。
>
> - DSH 安装目录（官方包已构建产物）：`E:\DSHDesktop\DSH Desktop\resources\app\node_modules\@deepseek-ai\`
> - 桌面 profile 已装插件：`C:\Users\NauchnyyUrod\.dsh\profiles\desktop\node_modules\`
> - 标注约定：**【源码确认】**= 直接读到实现/类型声明；**【实测确认】**= 在本机真实数据/进程上跑过；**【推断】**= 由多处证据合成、未找到单一权威说明。
> - 行号对应当前这套已安装产物；升级 DSH 后行号会漂移，函数名与结构不会。

---

## 0. 结论速览

| 问题 | 结论 | 关键 API |
|---|---|---|
| **Q6** 自定义投影 | **可行，且是推荐主路径**。宿主注册 `ctx.sessionProjections.register(def)`，客户端在 session 作用域 slot 里 `useProjection('key')` 读；历史会话由 `ctx.sessionQuery.observeSession(id, {projectionMode:'all'})` 在宿主侧**冷折叠全量日志**得到，持久检查点由 `session-projection-cache` 自动维护 | `sessionProjections.register` / `useProjection` / `sessionQuery.observeSession` |
| **Q1** HTTP 路由 | `ctx.webServer.register({kind:'exact'\|'prefix', path, handler(req,res)})`，返回 disposer；信任栅栏用 `ctx.get('connection').requestRejection(req)`（可选服务，缺失要降级） | `webServer.register` / `connection.requestRejection` |
| **Q2** 历史会话 | **不要读文件**：磁盘是**多帧 zstd** 拼接，Node 单次 `zstdDecompressSync` 只解第一帧（只有 header）；必须走 `ctx.sessionPersistence` 句柄或 `ctx.sessionQuery` | `sessionPersistence.list/open` → `handle.read()`；或 `sessionQuery.listSessions/readSession` |
| **Q3** 工作区归属 | 会话**没有** `workspaceId` 字段；归属规则 = `session.header.cwd` 的**规范路径（fs.realpath）**等于 `Workspace.path`；`Workspace.sessionIds` 是反查表 | `workspaceRegistry.list()/get()/resolveByPath()` |
| **Q4** `session` 对象字段 | `session.id`、`session.header`（含 `cwd/createdAt/parentSession/origin/delegationDepth/agentPreset`）、`session.seq`、`session.inheritedEventCount`、`snapshotEvents()`；**没有 title/workspaceId** | `SessionEventMap['assistant/message'].usage` |
| **Q5** 插件持久化 | 官方有：`defineDomain` + `ctx.storageDomain.open(spec)` → `~/.dsh/storages/<domain>.json`；社区约定：`$DSH_HOME/.dshw-*.json`（whale-widget 自读写） | `storageDomain.open` / `domain.table()` |

一句话架构建议：**宿主注册一个带 `wire` 的 `turnCost` 投影单元**（状态里存分模型/分档累计，`wire.view` 只吐小对象），客户端 `useProjection('turnCost')` 直接显示；跨会话/跨工作区聚合在宿主侧用 `sessionQuery.listSessions()` + `workspaceRegistry.list()` + 逐会话 `observeSession()` 回填一次，之后靠 `session/event` 增量维护。

---

## Q6（最高优先级）自定义 Session Projection：注册与读取

### Q6.1 客户端怎么读自定义投影？

**【源码确认】** 客户端拿到的 `useProjection` **不是**一个全局 hook，而是"**session 作用域 standard props**"里由 `dsh-client-ui-session` 贡献的**键控 hook**：

- 键控源的名字是 `projection`，贡献点在 `dsh-client-ui-session/lib/client.js:755-764`：

  ```js
  const BUILTIN_SOURCE = {
    hooks: ["session"],
    keyedHooks: ["projection"],
    props: ["sessionId"],
    resolve: (binding) => ({
      hooks: { session: binding.session },
      keyedHooks: { projection: (key) => binding.session.projections.faceOf(key) },
      props: { sessionId: binding.sessionId }
    })
  };
  ```

- prop 名由 `standardHookPropName` 生成（`dsh-client-ui-slots/lib/index.js:7-9`）：

  ```js
  function standardHookPropName(name) {
    return `use${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
  }
  ```

  ⇒ `projection` → **`useProjection`**。

- 调用形态由 `keyedHookCall` 解析（`dsh-client-ui-renderer/lib/client.js:245-264`），实现是 `keyedObservableHook`（同文件 `270-287`）：

  | 写法 | 含义 |
  |---|---|
  | `useProjection('turnCost')` | 返回当前值（`selector = identity`），未注册/无值时 `undefined` |
  | `useProjection('turnCost', (v) => v?.total ?? 0)` | 返回 `selector(value)` |
  | `useProjection('turnCost', sel, equal)` | 自定义等值比较，抑制重渲染 |
  | `useProjection('turnCost', 'member')` | 取 `value.member`（字符串第二参走 keyed 的 `member` 形态） |

- 底层 face 是 `ObservableSnapshot`：`{ getSnapshot(), subscribe(listener) }`，见 `dsh-api-session-controller/lib/types/client/sessions/projection-store.js:29-31`（`faceOf`）、`145-160`（创建 face）；hook 内部用 `react.useSyncExternalStore` 语义绑定（`dsh-client-ui-renderer/lib/client.js:219-226` + `270-287`）。

**客户端唯一硬约束**：必须在 **session 作用域**的 slot 里调用（即组件 props 里有 `useProjection`）。root 作用域的 slot 没有这个 prop。现有用法可直接抄：`dsh-client-ui-chat/lib/client.js:7605`（`const usage = useProjection("tokenUsage")`）、`dsh-client-ui-chat/lib/client.js:7491`（带 selector）。

**`wire.viewSchema` 是不是必须是 zod？** 是——**【源码确认】**：

- 类型声明 `ProjectionDefinition`（`dsh-tool-cordis/lib/types/api-catalog.js:6467-6469`）：

  ```ts
  export interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S ...> {
      key: K;
      stateSchema: ZodType<S>;
      init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>;
      apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>;
      wire?: K extends keyof SessionProjectionMap ? {
          viewSchema: ZodType<SessionProjectionMap[K]>;
          view(state: NoInfer<S>): SessionProjectionMap[K];
      } : never;
      stateVersion: number;
  }
  ```

- 运行时到处在 `.parse()`：`viewSchema.parse(...)` 在 `dsh-session-projection/lib/index.js:421`、`432`、`258`、`304`；`stateSchema.parse(...)` 在同文件 `254`、`296`。
- 本机可用的 zod 是 **4.6.5**（`C:\Users\NauchnyyUrod\.dsh\profiles\desktop\node_modules\zod\package.json`）。插件被 junction 到 profile 的 `node_modules` 下，`import { z } from 'zod'` 能解析到它；**只要是能 `.parse()` 的 zod 实例即可，不要求与宿主同一个实例**（注册表只调 `viewSchema.parse` / `stateSchema.parse`）。**【推断】**（基于代码只用到 `.parse`）

**运行时不会校验 key 是否在类型表里**：`register()` 只校验 `stateVersion` 是非负整数（`dsh-session-projection/lib/index.js:81`）。`SessionProjectionMap` / `SessionProjectionStateMap` 在产物里是**空接口**（`api-catalog.js:7263-7264`、`7271-7272`），纯 TS 类型合并点。所以纯 JS 插件可以用任意 key（如 `'turnCost'`）**【源码确认】**。

### Q6.2 宿主端怎么读某个 Session 的投影当前值？

**【源码确认】** `ctx.sessionProjections`（`SessionProjectionRegistry`，`dsh-session-projection/lib/index.js`）：

| 方法 | 签名 | 行为 | 行号 |
|---|---|---|---|
| `register` | `register(definition): () => void` | 挂单元；同 key 同 `stateVersion` 共享 cell；不同版本 throw；disposer 挂在调用方 fiber 上 | `68-102` |
| `stateOf` | `stateOf(session, key): S \| undefined` | 读**实时 host 状态**（不产出 wire 视图）；未注册返回 `undefined` | `126-131` |
| `snapshot` | `snapshot(session, keys?): { asOfSeq, values }` | 一次一致切面；**只含 `wire` 单元** | `141-155`（`146` 行 `if (registration.def.wire === void 0) continue;`） |
| `cachedSnapshot` | `cachedSnapshot(session, keys?)` | 只读已物化 cell，可能落后 | `164-180` |
| `checkpoint` | `checkpoint(session)` | 每个单元一行 `{ver, seq, val}`，`val` 是 detached clone | `195-206` |
| `hydrate` | `hydrate(session, checkpoint, events, baseSeq)` | 冷读：检查点行 + 尾部日志重放 | `329-360` |
| `restore` | `restore(checkpoint, events, baseSeq, header, inheritedEventCount)` | 纯函数冷折叠，返回 `{snapshot, checkpoint}` | `286-318` |
| `viewCheckpoint` | `viewCheckpoint(checkpoint, keys?)` | 零 I/O 看检查点行（`stateSchema.parse` + `wire.view`） | `243-261` |
| `onChanged` | `onChanged(listener): () => void` | 逐变更通知 `(session, key, value, seq)` | `109-117` |

> **关键坑（决定架构）**：`snapshot` / `cachedSnapshot` / `viewCheckpoint` / `restore` 的 `values` **只输出定义了 `wire` 的单元**（`146`、`173`、`248`、`304`）。host-only 单元（不带 `wire`）只能在**已持有 `Session` 对象**时用 `stateOf()` 读。
> ⇒ 想让"宿主侧跨会话读回自己的 key"成立，**必须给 `turnCost` 定义 `wire`**（副作用：该 key 也会进客户端快照/帧，值要小）。

另外有一个更省事的"**只给 header 就能读**"的入口：`ctx.sessionProjectionCache`（`dsh-session-projection-cache`，base 层已挂载）：

- `cachedSnapshot(meta: SessionHeader, keys?): ProjectionSnapshot | undefined`（`dsh-session-projection-cache/lib/index.js:192-197`；目录声明 `api-catalog.js:2206`）
  - 零 I/O，从存储域内存表直接取；按**生命周期身份**（`formatVersion`/`createdAt`/`cwd`/`isSeeded`）匹配；行 `ver` 与当前 `stateVersion` 不符则该 key 缺失。
  - 只需 header，**不需要 Session 对象、不读日志**。
- `coldSnapshot(meta, inheritedEventCount, events)`（同包 README `:61`）——给了完整日志就能算，且会顺手刷新检查点。

### Q6.3 宿主端怎么枚举「所有会话」并拿到它们的投影值？

**能拿到，链路是 `sessionQuery`**（base 层 `session-query-sqlite` 已挂载，见 `dsh-base/cordis.patch.yml:157-161`，`openAt: never` 只关全文检索，精确读照常）：

```js
// ① 列出全部逻辑会话（含 live + 已持久化的冷会话，newest-first，header 已 clone）
const records = await ctx.sessionQuery.listSessions()      // SessionRecord[]
// records[i] = { header: SessionHeader, live: boolean, persisted: boolean, formatStatus? }
//   dsh-session-query/lib/index.js:95-118（实现）、1072-1074（公开方法）

// ② 逐个观测：冷会话会自动 prepare + 冷折叠全部投影单元
const obs = await ctx.sessionQuery.observeSession(records[i].header.id, { projectionMode: 'all' })
const values = obs.projections?.values ?? {}              // ← 你的 'turnCost' 就在这里
const cost = values.turnCost
obs[Symbol.dispose]()                                     // 观测是租约，必须释放
```

证据（全部 **【源码确认】**）：

- `observeSession` 公开入口：`dsh-session-query/lib/index.js:1064-1066`（转 `_observations.read`）。
- 冷会话分支：`observeSession → read()` `350-397`：`stat` → 读全量日志 `loadSource` → `ctx.sessions.prepare(...)` → `preparedProjections(entry)`。
- **冷折叠 = 走全部已注册单元**：`preparedProjections` `509-514`：

  ```js
  preparedProjections(entry) {
      const registry = this.ctx.get("sessionProjections");
      if (registry === void 0) return void 0;
      const cache = this.ctx.get("sessionProjectionCache");
      return cache === void 0 ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
                              : cache.hydratePrepared(entry.session, entry.events);
  }
  ```

- 活会话分支：`live()` `477-507`，`projections = this.ctx.get("sessionProjections")?.snapshot(session)`。
- 观测对象是**可释放租约**：`preparedLease` `450-476`、`live` `486-507`，释放方式是 `[Symbol.dispose]()`；`retain()` 续租。`projectionMode: 'none'` 可跳过投影计算（`351`）。

**结论（Q6.3 的直接答案）**：宿主**可以**读其它会话（包括本次安装之前就结束的历史会话）的投影值——不是"只能读活会话"。两条路径：

1. **零 I/O 快路**：`ctx.sessionProjectionCache.cachedSnapshot(header, ['turnCost'])` —— 只对**已有该 key 检查点行**的会话有效。你的 key 是新注册的，**历史会话没有这一行**，首次必然是 `undefined`（`viewCheckpoint` 在 `251` 行按 `row.ver !== def.stateVersion` 直接跳过）。
2. **冷折叠慢路**：`ctx.sessionQuery.observeSession(id, {projectionMode:'all'})` —— 首次每会话读一次完整日志；随后 `session-projection-cache` 会把**你的 row 也一起**刷进 `~/.dsh/storages/session_projcache/sessions/<id>.json`（`checkpoint()` 遍历**所有**已注册单元，`dsh-session-projection/lib/index.js:195-206`），下次就走快路。

> **【实测确认】** 检查点文件已存在且确实按 key 存了行：`~/.dsh/storages/session_projcache/sessions/*.json` → `record.rows.tokenUsage = { ver: 2, seq: 1279, val: { totals, last } }`，同目录还有 `title`、`sessionStats`、`contextPressure` 等 28 个 key。
> ⇒ **即便你什么都不注册，`tokenUsage.totals` 也已经对所有被 checkpoint 过的历史会话可读**（零 I/O）。但它只有 `uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens` 四个计数，**没有分模型、没有分峰谷**，无法直接算钱。

### Q6.4 如果宿主端读不到（本机结论：读得到）

读得到，所以不需要"host 自己维护全局 Map + 启动时读 JSONL"。

但**仍然建议**保留一层宿主内存 Map 作为**聚合缓存**（不是为了回放，而是为了工作区聚合的响应速度）：

- 回放/持久化的真源 = projection（`apply` 冷折叠 + cache 检查点），不要自己写账本文件；
- 宿主内存 Map `Map<sessionId, {workspaceId, totalCny, byModel, updatedSeq}>` 只做"跨会话求和"的增量维护，启动时用一次 `listSessions + observeSession` 回填；
- 这样避免了"自建 JSONL 解析器"和"两套账"的风险（zstd 多帧这一点已经证明自建解析器很脆，见 Q2）。

---

## Q1. HTTP 路由：宿主插件怎么注册只给本机客户端用的 GET？

### 官方推荐形态

**【源码确认】** `@deepseek-ai/dsh-host-webserver` 的 `WebServer` 服务（service 名 `webServer`，`lib/index.js:285-291` 构造 `super(ctx, "webServer")`）：

```js
// 精确路由
const dispose = ctx.webServer.register({ kind: 'exact', path: '/dsh-turn-cost/ledger.json', handler })
// 前缀路由
ctx.webServer.register({ kind: 'prefix', path: '/dsh-turn-cost/', handler })
// upgrade（WebSocket 等）
ctx.webServer.registerUpgrade({ path: '/dsh-turn-cost/ws', handler })
```

- `register(route)`：`kind` 只能是 `'exact'` 或 `'prefix'`；重复路径 **throw**；返回 disposer。`lib/index.js:326-333`
- `registerUpgrade(route)`：只精确匹配。`lib/index.js:340-346`
- `registerFallback(handler)`：**唯一**回退席位（第二个注册 throw），随附 Web 组合里被 SPA dist 占用 → **我们不要碰**。`lib/index.js:355-361`
- handler 签名 `(req: IncomingMessage, res: ServerResponse) => Promise<void> | void`；由 `Service.init` 的 `handle` 调用，**抛错 → 记 warning 并回 400**（头已发出则销毁 socket），不会崩进程。`lib/index.js:378-398` + README `:71`
- 匹配顺序：精确表 → 最长前缀 → fallback；`new URL(req.url,'http://x').pathname` 取 pathname（**不含 query**，query 自己从 `req.url` 解）。`lib/index.js:381-393`
- `ctx.webServer.port` / `.host` / `.protocol` / `.getOrigin()`：`lib/index.js:293-319`
- README 明确写着"**不提供服务器级认证或来源策略**，各 route owner 自己实施"（`README.zh.md:130`）。

最小 GET 例子（照抄 whale-widget 的形状）：

```js
ctx.inject(['webServer'], (scope) => {
  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: '/dsh-turn-cost/ledger.json',
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, workspaces: [] }))
    },
  }))
})
```

### 同源 / 回环校验：真正的栅栏在 `connection`，不在 webServer

**【源码确认】** `ctx.connection.requestRejection(request)`（`dsh-client-connection/lib/index.js:736-740`）：

```js
requestRejection(request) {
    const admission = this.admit(request);
    return "rejection" in admission ? admission.rejection : void 0;
}
admit(request) {
    if (!this.isTrusted(request)) return { rejection: 403 };   // Host/Origin 伪造、跨站
    if (this.disposed) return { rejection: 401 };
    const secure = this.owner.get("webServer")?.protocol === "https:";
    if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer };
    const id = this.browserAuth.authenticateApi(request, secure);
    const record = id === void 0 ? void 0 : this.peers.get(id);
    return record === void 0 ? { rejection: 401 } : { peer: record.peer };  // 无浏览器 cookie → 401
}
```

- Host/Origin 判定细节：`isTrustedApiRequest()` `240-250` —— Host 必须是**回环**、`--trusted-host` 声明的权威、或绑定地址本身；`Sec-Fetch-Site: cross-site` 一律拒；带 `Origin` 时必须与 Host 同源。
- 浏览器鉴权：`isAuthenticated()` `546-548`，验的是 `dsh-auth-*` **签名 cookie**（`browserAuth`，`271-578`）。
- ⇒ **【源码确认】** 即使请求来自 127.0.0.1，**没有浏览器 cookie 的裸 `curl` 也会拿到 401**。GUI 页面里同源 `fetch()` 会自动带 cookie，所以前端调自己的路由没问题；**但"本机脚本/curl 自测"必须带上 cookie，或改用带 `?token=` 的启动 URL**（`TOKEN_QUERY = "token"`，`lib/index.js:276`）**【推断】**。

whale-widget 的三层写法值得抄（它踩过 `requestRejection` 不存在的旧宿主的坑）：`dsh-whale-widget/lib/index.js`

- `749`：`root.inject(['webServer', 'credentials', 'connection'], (ctx) => {...})`
- `803-808`：**用 `ctx.get('connection')` 读可选服务**，不写进 object-level `inject`（否则旧宿主整个插件不 apply）
- `848-874`：`rejected(req,res)` = 自校验 → 委托 `conn.requestRejection(req)` → **它抛异常按拒绝处理**（fail-closed）
- `876-885`：统一包装，所有路由自动套栅栏：

  ```js
  function registerRoute(route) {
    const inner = route && route.handler
    const wrapped = Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return inner(req, res)
      },
    })
    return ctx.webServer.register(wrapped)
  }
  ```

- 真实 GET 例子：`3548-3565`（`/dsh-whale/image.png`，`res.writeHead(200, {...}); res.end(bytes)`）、`3586-3617`（`/dsh-whale/balance.json`，async handler + 自己解析 query）。
- 读 body（PUT/POST 用）：`readBody(req)`，用法见 `3632-3650`。

### 前端注入（本插件 `dsh.client` 已自带 bundle，可略）

桌面壳走**结构化注入行**而不是 `tapIndex`：`ctx.on('webserver/index-inject', (table) => table.push({kind:'script', ...}))`（事件签名 `'webserver/index-inject'(table: IndexInjection[])`，`api-catalog.js:4516-4518`；whale 用法 `735-746`，踩坑注释 `706-721`）。本插件已有 `dsh.client.bundle`，**通常不需要**这条；只有"桌面端也要注入脚本"时才用。

---

## Q2. 历史会话：怎么读到已结束/历史会话的完整事件？

### 磁盘格式（先看事实）

**【实测确认】** `~/.dsh/sessions/` 的层级：

```
<root: ~/.dsh/sessions>/
  --<normalized-cwd>--/                 # 可读的项目目录名，如 --E-ai~0020project-...--
    <sessionId>/                        # 会话自有目录（id 被单射转义；subagent 会话目录名不带 session- 前缀）
      session.v4.jsonl.zstd             # 当前格式；v0..v4 历史代际并存
```

与官方文档一致（`@deepseek-ai/dsh-session-persistence-jsonl/README.zh.md:55-73`；`root` 由 base 层配置为 `dshHomePath('sessions')`，见 `dsh-base/cordis.patch.yml:138-141`）。

**header 行**（对最小的那个文件解压后第 1 行，原样）：

```json
{"type":"session","version":4,"id":"session-e577e4f9-3c44-4269-b7fd-2532f0bc46d8","createdAt":1792417641999,"cwd":"E:\\ai project\\价格显示插件","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

子代理会话多两个字段：`"parentSession":"session-9cc5451a-...","origin":"subagent","delegationDepth":1`。

**每个事件行**是 `SessionEvent` 信封（**【源码确认】** `api-catalog.js:7015-7016`）：

```ts
{ type: K, seq: SessionSeq, time: number, data: SessionEventMap[K], ignorable?: true }
```

### ⚠️ 不要自己解 zstd：文件是**多帧**拼接

**【实测确认】** 用 Node 22.18 的 `zlib.zstdDecompressSync()` 解一个 182 KB 的 `session.v4.jsonl.zstd`，**只得到 1 行（header）**；改用 `createZstdDecompress()` 流式解码则在第一帧结束后报 `ZSTD_error_prefix_unknown`。原因在官方文档里写着：默认产物是"**独立 Zstandard 帧的标准拼接**：一个仅包含 header 行的校验和帧，后跟每个持久 append 批次一个校验和帧"（`README.zh.md:111`），且明确列为已知限制"**压缩文件不能直接按行读取**——使用后端加载"（`README.zh.md:166`）。

⇒ 历史回放**只有**两条正路：`sessionPersistence` 句柄，或 `sessionQuery`。手写帧扫描器属于自己重实现 `src/zstd.ts` 的帧扫描（官方包内私有）。

### 官方 API（一）：`ctx.sessionPersistence`

**【源码确认】** `@deepseek-ai/dsh-session-persistence/README.zh.md:34-49` + `api-catalog.js:2156-2198`：

```js
const all   = await ctx.sessionPersistence.list()        // SessionPersistenceSnapshot[]
const snap  = await ctx.sessionPersistence.stat(id)      // 不读日志的 header + revision
const r     = await ctx.sessionPersistence.open(id, 'read')  // 只读句柄，不抢写权
const { eventState, events } = await r.read()             // 全量；或 read(offset, length)
await r.close()
```

- `list()`：**无分页、无过滤**，返回每个本进程可见的已存会话；"只选并转换最高 generation 的 header，不读事件行"（README `:87`）。
- `SessionPersistenceSnapshot`（`api-catalog.js:7247-7248`）：

  ```ts
  { header: SessionHeader; formatStatus?: 'current'|'migration-required';
    revision: SessionPersistenceRevision; eventCount?: number; sizeBytes?: number }
  ```

- `SessionHandle`（`api-catalog.js:7119-7120`）：`id / header / inheritedEventCount / access / read(offset?,length?) / append / flush / close()`。
- `read()` 返回 `{ eventState: 'detached'|'shared-frozen', events }`；`detached` 属于你、可改，`shared-frozen` 深度冻结**不可改**（README `:49`）。
- 注意 `open(id,'write')` 会**抢单写者所有权**（`SessionAlreadyOwnedError`），做统计一律 `'read'`。

### 官方 API（二）：`ctx.sessionQuery`（更省事，推荐）

**【源码确认】** `api-catalog.js:2311-2409` + 实现 `dsh-session-query/lib/index.js`：

```js
// ① 只要 header（最省）：newest-first，live 优先
const records = await ctx.sessionQuery.listSessions()     // SessionRecord[] {header, live, persisted, formatStatus?}

// ② 要完整事件：读 + 回放校验，但**不让会话变 live**
const { session, inheritedEventCount, events } = await ctx.sessionQuery.readSession(id)
//   ↑ 注意字段名是 session（header 的 clone），不是 header。dsh-session-query/lib/index.js:1081-1089

// ③ 要投影值（含冷折叠）：见 Q6.3
const obs = await ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })
```

- `listSessions` 实现 `95-118`：把 `sessionPersistence.list()` 的 header 与内存 `ctx.sessions.list()` 合并、去重、newest-first、`structuredClone`。
- `readSession` 实现 `1081-1089`：`_corpus.load(id)`（live 优先，冷则读持久化）→ `Session.create(...)` 做回放校验 → 返回 `{ session: header, inheritedEventCount, events }`（events 已 `snapshotSessionEvent`）。
- `observeSession` 见 Q6.3。
- 注意：`session-query-sqlite` 在 base 层 `openAt: never`（`dsh-base/cordis.patch.yml:157-161`），**全文检索不可用**（`searchSessions` 会报 `SESSION_QUERY_SEARCH_DISABLED`），但 `listSessions/readSession/observeSession/readTitle` 这些"精确读"是**具体行为、与后端无关**，照常可用（`api-catalog.js:2313`）。

### 每行 JSON 的关键字段（回放时真正要用的）

| 用途 | 字段 |
|---|---|
| 头部 | `header.type='session'`、`version`、`id`、`createdAt`、`cwd?`、`isSeeded`、`parentSession?`、`origin?`、`delegationDepth?`、`agentPreset?`（`api-catalog.js:7139-7140`） |
| 用量 | `assistant/message.data.{turn, step, usage?, message}`；`usage: TokenUsage`（`api-catalog.js:7023`、`8119`） |
| 模型 | `assistant/message.data.message.source`（`AssistantMessage extends MessageBase { role:'assistant'; source: ModelMessageSource }`，`api-catalog.js:4791`；`ModelMessageSource extends AssistantProviderMetadata { kind:'model' }`，`6163`） |
| 轮结束 | `turn/end.data.{turn, reason}`，`reason.kind ∈ completed/aborted/blocked/error/max-tokens/interrupted/forked`（`api-catalog.js:7023`、`8307`） |
| TokenUsage 全字段 | `inputTokens`、`outputTokens`、`totalTokens?`、`cacheReadTokens?`、`cacheWriteTokens?`、`reasoningTokens?`（`api-catalog.js:8119`） |

> **口径提醒（whale-widget 已验证）**：`reasoningTokens ⊆ outputTokens`（`dsh-token-meter` 会校验 `reasoningTokens > outputTokens` 为非法），所以 **不能**把 reasoning 再累加一次，否则输出侧重复计费（whale `dsh-whale-widget/lib/index.js:966-970` 的注释与 `outputBilled = output`）。

---

## Q3. 工作区归属：一个会话属于哪个工作区？

### 服务与实体

**【源码确认】** 服务名 **`ctx.workspaceRegistry`**（不是 `ctx.workspace`），插件包 `@deepseek-ai/dsh-workspace`，README `:2`（"Workspace 实体注册表（ctx.workspaceRegistry）"）、`:57-59`、`:152`。

关键方法（`api-catalog.js:3847-3912`）：

| 方法 | 签名 | 说明 |
|---|---|---|
| `list()` | `(): Workspace[]` | **同步**、持久注册顺序；每个实体的 `sessionIds` **已按启动/实时的 canonical-cwd header 索引过滤**；不做任何持久化读 |
| `get(id)` | `(id: WorkspaceId): Workspace \| undefined` | 按 id 取 |
| `resolveByPath(path)` | `async (path: string): Promise<Workspace \| undefined>` | 按**规范目录路径**反查；不创建、不改写；路径不存在时 `realpath` 抛错；目录存在但没被登记 → `undefined` |
| `create(path, title?)` | `async` | 建或复用；`fs.realpath` 规范化；相对路径/不存在/非目录 → 拒绝 |

`Workspace` 实体（`api-catalog.js:8663-8664`）：

```ts
export interface Workspace {
    readonly id: WorkspaceId;
    readonly path: string;          // 规范路径（realpath 后）
    readonly title: string;
    readonly createdAt: string;     // ISO 字符串
    readonly updatedAt: string;
    readonly sessionIds: readonly SessionId[];
    setTitle(title): Promise<void>;
    attachSession(sessionId): Promise<void>;
    insertSessionBefore(sessionId, beforeSessionId?): Promise<void>;
    detachSession(sessionId): Promise<void>;
    status(): Promise<'ok' | 'missing-dir'>;
}
```

**【实测确认】** `~/.dsh/storages/workspace.json` 的真实记录形状：

```json
{"path":"E:\\ai project\\ELF","title":"ELF",
 "sessionIds":["session-917998ec-36bb-4c10-a6f4-9bb1333477f5"],
 "createdAt":"2026-09-15T06:55:59.393Z","updatedAt":"2026-09-15T06:55:59.578Z"}
```

（同文件 `global` 里有权威顺序 `workspaceIds`、`archivedSessionIds`、`pinnedSessionIds`；共 23 个工作区。）

### 会话 ↔ 工作区的关系：靠 cwd，不靠 id

**【源码确认】** `dsh-workspace/README.zh.md:71-73`：

> 会话加入它运行目录所在的项目：在项目目录中创建会话，它就会出现在该项目下……**新会话必须记录可解析为项目目录的工作目录**。已记账会话的完整绝对路径缺失时（包括悬空符号链接），仍保留原项目与顺序……头部缺失、无效记录路径、现存但不匹配的目录……会被排除。

- 唯一性规范是 **`fs.realpath`**（README `:93`："路径以规范化形式存储，因此指向已有记录目录的符号链接会与之冲突，唯一性即规范路径的字符串相等"）。
- 判定只读 **`SessionHeader`**，**绝不加载事件正文**（README `:95`："仅读取头部"）。
- **`session` 对象上没有 `workspaceId` 字段**（`SessionHeader` 声明 `api-catalog.js:7139-7140`，`Session` 声明 `6928`）。`session.cwd` 这个拼写也不存在——是 **`session.header.cwd`**（whale-widget 也从没读 `.cwd`，它只用 `session.id`）。

### 最可靠的宿主端映射片段

```js
// 建立 workspace 反查表 + cwd → workspace 映射（一次，之后靠事件增量）
function buildWorkspaceIndex(registry) {
  const byId = new Map()          // workspaceId → Workspace
  const bySession = new Map()     // sessionId  → workspaceId   （权威记账关系）
  const byPath = new Map()        // 规范化路径 → workspaceId
  for (const ws of registry.list()) {
    byId.set(ws.id, ws)
    byPath.set(normalize(ws.path), ws.id)
    for (const sid of ws.sessionIds) bySession.set(sid, ws.id)
  }
  return { byId, bySession, byPath }
}

function normalize(p) {
  // Windows 上盘符大小写、斜杠方向都不稳定；只用于比较，不用于展示
  return String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

// 单个会话的归属：先查记账表，再退回 cwd 反查
function workspaceOf(session, index) {
  const hit = index.bySession.get(session.id)
  if (hit) return hit
  const cwd = session.header?.cwd
  return cwd ? index.byPath.get(normalize(cwd)) : undefined
}
```

理由与坑（**【推断】**，由上述源码/实测合成）：

1. `bySession` 优先——它是 workspace 插件自己维护的**权威归属**，能兜住"目录后来被移动/删除但归属保留"的情况（README `:73`、`:170`）。
2. `byPath` 兜底——`sessionIds` 经过 canonical-cwd 索引过滤，**没有登记过的会话可能不在里面**（例如插件安装前就存在、且从未 attach 的会话，或 `origin:'subagent'` 的子会话）。
3. 比较务必先规范化：`header.cwd` 是"创建时的 cwd 写法"，`Workspace.path` 是 `realpath` 结果；**Windows 下盘符大小写与斜杠方向不保证一致**。要 100% 严谨可以 `fs.realpathSync.native` 两边都算一次（但目录已删除时 `realpath` 会抛错，必须 try/catch 回落到字符串比较）。
4. `ctx.workspaceRegistry.list()` 是**同步**的、零 I/O，可以每个请求都调；但 `create()/attachSession()` 是 async 写链。

**【实测确认】** 桌面端确实挂了这个服务，三重证据：

1. `~/.dsh/storages/workspace.json` 存在且有 23 条记录；
2. `@deepseek-ai/dsh-workspace` 在 web 层组合里（`dsh-web-app/cordis.patch.yml:91-92`），服务名就是 `workspaceRegistry`（`dsh-workspace/lib/index.js:376`）；
3. 当前 profile 的 bundles 明确含 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`（`C:\Users\NauchnyyUrod\.dsh\profiles\desktop\package.json:20-22`），即桌面端 = base 层 + web 层全量组合。

> **可选服务警告**：`workspace` 挂在 **web-app 层**而不是 base 层（`dsh-base/cordis.patch.yml` 里没有 `dsh-workspace` 行）。所以插件里必须用 **`ctx.get('workspaceRegistry')`** 读，**不要**写进 object-level `inject`；读不到就退化成"按 cwd 目录名聚合"。这是 whale-widget 用血泪注释写在 `725-730` 的同一条纪律。

---

## Q4. `session/event` 回调里的 `session` 对象有哪些字段？

**【源码确认】** 事件契约（`api-catalog.js:4380-4382`）：

```ts
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

订阅形态（whale-widget `dsh-whale-widget/lib/index.js:1128-1136`，真机在用）：

```js
ctx.on('session/event', (session, event) => {
  const sid = session && session.id ? session.id : 'default'
  // 注意：所有会话（含 subagent 会话）都会从这里过
})
ctx.on('session/disposed', (session) => { /* 清理该会话的聚合 */ })
```

`Session` 类声明（`api-catalog.js:6928`）：

```ts
export class Session {
    get surface(): SessionSurface;
    readonly header: SessionHeader;
    readonly inheritedEventCount: SessionLogOffset;
    get id(): SessionId;
    readonly firstLiveSeq: SessionLogOffset;
    readonly firstLifecycleSeq: SessionLogOffset;
    eventAt(seq): SessionEvent | undefined;
    snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[];
    ownEvents(): readonly SessionEvent[];
    isOwnSeq(seq): boolean;
    get seq(): SessionLogOffset;
    append(...); requestHeader(); requestContext(); toolHistory(); deriveMessages();
    deriveEventMessage(event): Message | null;
}
```

`SessionHeader`（`api-catalog.js:7139-7140`）：

```ts
export interface SessionHeader {
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: SessionId;
    readonly createdAt: number;        // epoch ms
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
}
```

⇒ 在 `session/event` 里**能直接拿到**：`session.id`、`session.header.cwd`、`session.header.createdAt`、`session.header.parentSession`、`session.header.origin`、`session.header.delegationDepth`、`session.header.agentPreset`、`session.seq`、`session.inheritedEventCount`。

⇒ **拿不到**：`session.workspaceId`（不存在）、`session.title`（title 是投影 key `'title'`，`~/.dsh/storages/session_projcache` 里可见 `rows.title`）、`session.cwd`（不存在，必须走 `header.cwd`）。

**这决定账本能不能直接记 workspaceId**：不能。账本里要**存 `sessionId` + `cwd` 快照**，`workspaceId` 由 Q3 的映射算出来（并缓存；workspace 改名/移动不会改变归属，但目录被删除后仍要能显示，所以要存一份 `cwd` 兜底）。

其它可直接用的事件签名（**【源码确认】** `api-catalog.js`）：

| 事件 | 签名 | 行号 |
|---|---|---|
| `session/created` | `(session: Session): void` | `4364-4366` |
| `session/disposed` | `(session: Session): void` | `4372-4374` |
| `session/event` | `(session: Session, event: SessionEvent): void` | `4380-4382` |
| `subagent/start` | `(info: SubagentRunInfo): void` | `4436-4438` |
| `subagent/end` | `(info: SubagentRunEndInfo): void` | `4412-4414` |
| `webserver/index-inject` | `(table: IndexInjection[]): void` | `4516-4518` |
| `domain/changed` | `(change: DomainChanged): void` | `4220-4222` |

`SubagentRunInfo` `{ runId, provider, id: SessionId, local }`（`api-catalog.js:7819`）；`SubagentRunEndInfo` 再加 `stopReason`、`lastAssistantMessage?`（`7811`）。**子代理会话 id = `info.id`**，用它把子会话标成"子代理"（whale 的 `rememberSubagentSession`，`1112-1125`）。

---

## Q5. 插件自己的账本写在哪？

### 官方路径（推荐）：`ctx.storageDomain` + 自定义 domain

**【源码确认】** `@deepseek-ai/dsh-storage-domain`，base 层已挂载（`dsh-base/cordis.patch.yml:187-190`，`backend: json`），后端根 `~/.dsh/storages`（同文件 `182-185`）。

```js
// ① 声明（模块级一次；name 必须匹配 /^[a-z][a-z0-9_]*$/）
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const turnCostSpec = defineDomain({
  name: 'turn_cost',                     // → ~/.dsh/storages/turn_cost.json
  version: 1,
  tables: {
    sessions: domainTable(z.object({
      sessionId: z.string(),
      cwd: z.string().optional(),
      workspaceId: z.string().optional(),
      totalCny: z.number().nonnegative(),
      updatedSeq: z.number().int().nonnegative(),
    }).strict()),
  },
})

// ② 打开（调用方拥有句柄，用 ctx.effect 释放）
ctx.inject(['storageDomain'], (scope) => {
  scope.effect(() => {
    let domain
    scope.storageDomain.open(turnCostSpec).then((d) => { domain = d }).catch((e) => { scope.logger?.warn?.(e) })
    return () => { domain?.close()?.catch?.(() => {}) }
  })
})
// ③ 用
// domain.table('sessions').get(id)            // 同步读内存
// domain.table('sessions').entries()          // 同步遍历
// await domain.table('sessions').put(id, rec) // 持久写：后端确认后才改内存，然后 emit domain/changed
// await domain.table('sessions').update(id, (r) => ({...r, totalCny: n}))
// await domain.global.set({ initialized: true }); domain.global.get()
```

证据：

- `defineDomain(spec)`：校验 name/version/table 名/global 不可接受 `null`；`domainTable(schema)` 包一层 `{valueSchema}` —— `dsh-storage-domain/lib/index.js:46-48`、`61-76`；导出清单同文件 `454`。
- `ctx.storageDomain.open(spec): Promise<Domain<S>>`：`api-catalog.js:2910-2919`（含失败码 `already-open` / `backend-not-found` / `facet-unsupported` / `invalid-record` / `version-mismatch`）。**同一个 domain 名不允许被两个插件同时打开**（`already-open`）。
- `Domain` 运行时：`table(name)` `187-191`；`global.get/set` `157-173`；`close()` `198-208`。
- 表句柄 `KvTableImpl`：`get(key)` `241-244`、`entries()` `245-248`、`keys()` `249-252`、`size` `253-256`、`put(key,value)` `257-263`、`delete(key)` `264-277`、`update(key,fn)` `278+`。**读同步、写 async 且先落盘**（`:88` 设计理念）。
- 落盘位置与布局：`dsh-storage-json/README.zh.md:36-56` —— 默认 `single` 布局，即 `<root>/<unit>.json`；`root` = `~/.dsh/storages`。**【实测确认】** 同目录下已有 `workspace.json`、`schedule.json`、`session_projcache/`（per-record）。
- `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`dsh-storage/lib/index.js:80`）。

优点：schema 校验、写入串行化（每 domain 一条写链）、`domain/changed` 事件、原子发布、重启自愈；不会和宿主抢文件。

### 社区/插件约定：`$DSH_HOME/.dshw-*.json`

whale-widget 没有用 storage API，而是自己 `fs.writeFileSync` 到 **`$DSH_HOME`**：

- `DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')` —— `dsh-whale-widget/lib/index.js:24`
- 候选路径列表模式（`DSH_HOME` → `profiles/web` → 安装目录），例：`.dshw-usage.json` 在 `486-489`、`.dshw-turn.json` 在 `492-496`、`.dshw-api.json` 在 `159-162`、`.dshw-size.json` 在 `479-482`。
- 简单写法的实际代码（`898-913`）：

  ```js
  function readTurnSeq() {
    for (const p of TURN_FILE_CANDIDATES) {
      try { const parsed = JSON.parse(fs.readFileSync(p, 'utf8')); if (typeof parsed.seq === 'number') return parsed.seq } catch (err) {}
    }
    return 0
  }
  function writeTurnSeq(seq) {
    const body = JSON.stringify({ seq, updatedAt: new Date().toISOString() })
    for (const p of TURN_FILE_CANDIDATES) { try { fs.writeFileSync(p, body, 'utf8'); return } catch (err) {} }
  }
  ```

**【推断】** `~/.dsh/` 下**没有官方"插件私有目录"约定**；`storages/` 是唯一有官方语义的宿主侧持久化位置，`.dshw-*` 只是 whale-widget 的自选命名（它是靠"多候选路径 + 静默失败"来容错的）。另外它踩过的坑在 `35`、`64-69` 的注释里（两端各写一份、路径压缩后 `$DSH_HOME` 匹配不到），值得引以为戒。

**建议**：账本若要跨重启且要参与聚合，用 `storageDomain`（`turn_cost` domain）；只用 `.dshw-*.json` 适合"极小、丢了也无所谓"的 UI 状态（如 whale 的 `seq`）。

---

## 推荐的账本设计

### 三层职责

| 层 | 载体 | 职责 |
|---|---|---|
| **① 真源（可回放）** | `turnCost` **projection unit**（`ctx.sessionProjections.register`） | 每会话、每轮的累计费用与分项。`apply()` 吃 `assistant/message` 累加、吃 `turn/end` 结算、吃 `llm/retry-started` 回滚重试槽位（照抄 `tokenUsageProjectionDefinition` 的容错套路） |
| **② 聚合索引（可重建）** | 宿主内存 `Map` + 可选 `storageDomain` `turn_cost` | `sessionId → {workspaceId, cwd, totalCny, byModel, updatedSeq}`；按 `workspaceId` 求和。启动回填一次，之后增量 |
| **③ 展示** | 客户端 `useProjection('turnCost')` + 一个 GET 路由给非 session 作用域的页面（工作区总览） | 会话内小计；跨工作区总览走路由 |

> **为什么①不用自己持久化**：`session-projection-cache` 会把**所有**已注册单元（`checkpoint()` 遍历全部 registration，`dsh-session-projection/lib/index.js:195-206`）按 `(sessionId, key, ver, seq, val)` 落盘到 `~/.dsh/storages/session_projcache/sessions/<id>.json`，并在 `session/created`、`turn/end`、`session/disposed` 三个必写点刷（`dsh-session-projection-cache/README.zh.md:57`；配置见 `dsh-base/cordis.patch.yml:196-200`）。历史会话首次冷读由 `hydratePrepared` 顺手写回（`dsh-session-projection-cache/lib/index.js:247-255`）。

### 用哪些事件

| 事件 | 做什么 |
|---|---|
| `session/event` + `assistant/message` | 取 `data.turn`、`data.message.source.model`、`data.usage`；按 `(sessionId, turn)` 分桶累加（whale 的 `handleSessionEvent`，`944-991`，可直接对照） |
| `session/event` + `llm/retry-started` | 同一 `(turn, step)` 的替换槽位置空，避免重试重复计费（`usage-projection.js:92-96`） |
| `session/event` + `turn/end` | 本轮结算；`reason.kind === 'interrupted'` 时标记半截 |
| `session/created` | 初始化该会话 cell（projection 注册表内部已做；自建 Map 也要做） |
| `session/disposed` | 释放该会话的临时聚合，避免泄漏（whale `1134-1136`） |
| `subagent/start` / `subagent/end` | 标记 `info.id` 为子代理会话；聚合时按需排除或单列 |
| `session-title` 类投影 | 会话名用投影 key `'title'`（`sessionProjections.stateOf(session,'title')` 或 cache），**不要**自己 fold 顶部事件 |

### 存哪些字段

`turnCost` projection **state**（host-only 部分可以大）：

```js
{
  totals: { cny: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0 },   // 全会话累计
  byModel: { 'deepseek-flash': { cny, in, cacheRead, out } },       // 分模型（价格不同必须分开）
  byTier:  { peak: 0, offPeak: 0 },                                 // 峰谷分档
  turns: { count: 0, lastCost: 0, lastTs: 0 },                      // 展示用摘要
  seq: -1                                                           // 最后折叠到的 seq（自检用）
}
```

`wire.view` **只吐小对象**（它会进每个客户端的快照/帧，`README.zh.md:129` 明确"每个尾页携带每个 client-visible key"）：

```js
wire: {
  viewSchema: z.object({
    totalCny: z.number(), lastTurnCny: z.number(), turns: z.number().int(),
  }).strict(),
  view: (s) => ({ totalCny: round4(s.totals.cny), lastTurnCny: round4(s.turns.lastCost), turns: s.turns.count }),
}
```

聚合索引里额外存：`sessionId`、`cwd`（**快照**，目录没了也要能显示）、`workspaceId`（算出来的，可能滞后）、`createdAt`、`origin`。

### 如何回放历史（安装之前就结束的会话）

```
启动（或首次打开面板）
 ├─ records = await ctx.sessionQuery.listSessions()          // 全部会话 header
 ├─ wsIndex  = buildWorkspaceIndex(ctx.workspaceRegistry)     // cwd → workspaceId
 ├─ 先试零 I/O：ctx.sessionProjectionCache.cachedSnapshot(header, ['turnCost'])
 │    └─ 命中 → 直接用（只有"本次装好之后被 checkpoint 过"的会话会命中）
 └─ 未命中 → 并发受限（建议 2~4）地跑：
      obs = await ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })
      cost = obs.projections.values.turnCost
      obs[Symbol.dispose]()
```

要点：

1. **必须有 `wire`**，否则 `values` 里根本不会有你的 key（Q6.2 的坑）。
2. 冷折叠是**每会话一次全量日志读**（zstd 解码在宿主内部，正确但慢；本机 1.3 MB 级别的日志单会话可接受）。**不要**在每次 HTTP 请求里跑。
3. 首次回填要**可中断、可续做**：把"已回填到哪个 sessionId/何时"记在 `storageDomain` 的 `global` 里，插件重载后接着做。
4. `stateVersion` 一旦 +1，历史检查点行全部失配 → 全量重折（`restore()` 在 `baseSeq > 0` 时会 throw，但 cache 的 `hydratePrepared` **catch 后回落到全量重读**，所以不会炸，只是变慢：`dsh-session-projection-cache/lib/index.js:250-254`）。**发布后才想起要改口径，代价就是一次全量重折**，所以第一次就把字段设计全。

### 如何按工作区聚合

```js
// 增量：每个 turn/end 后更新一条，再把它加进 workspace 桶
const key = workspaceOfSession(sessionId) ?? 'unassigned'
wsTotals.set(key, (wsTotals.get(key) ?? 0) + deltaCny)

// 全量重算（面板打开 / 插件重载后）
const perWs = new Map()
for (const [sid, rec] of ledger) {
  const wsId = wsIndex.bySession.get(sid) ?? wsIndex.byPath.get(normalize(rec.cwd)) ?? 'unassigned'
  perWs.set(wsId, (perWs.get(wsId) ?? 0) + rec.totalCny)
}
```

工作区展示名：`ctx.workspaceRegistry.get(id)?.title ?? 目录名`；已删除目录的工作区 `status()` 返回 `'missing-dir'`（`api-catalog.js:8664`），UI 上应保留分组但标灰。

### 定价口径（与 whale 对齐，避免两套数字）

- `cacheReadTokens` 按**输入价**；`inputTokens` 是**未命中**部分，按未命中价；`outputTokens` **已含 reasoning**，不要再加一遍（whale `969-978`）。
- 峰谷：`isPeakTime(Math.floor(Date.now()/1000))`（whale `977`）——按**请求时刻**分档，所以 projection 里要按"事件 `time`"分档，而不是按查询时刻。
- 模型名取 `message.source.model`；取不到时归入"未知"（whale `937`）。

---

## 附录 A：证据索引（关键行号）

| 主题 | 文件 | 行 |
|---|---|---|
| route 注册 / upgrade / fallback / getOrigin | `@deepseek-ai/dsh-host-webserver/lib/index.js` | `326-333` / `340-346` / `355-361` / `293-319` |
| 路由匹配与 handler 调用 | 同上 | `378-398` |
| "不提供认证与来源策略" | `dsh-host-webserver/README.zh.md` | `130` |
| `requestRejection` / `admit` | `dsh-client-connection/lib/index.js` | `736-750` |
| Host/Origin 栅栏 | 同上 | `240-250` |
| 浏览器 cookie 鉴权 | 同上 | `546-570` |
| `session/event` 签名 | `dsh-tool-cordis/lib/types/api-catalog.js` | `4380-4382` |
| `SessionEvent` / `SessionEventMap` | 同上 | `7015` / `7023` |
| `TokenUsage` | 同上 | `8119` |
| `Session` / `SessionHeader` | 同上 | `6928` / `7139-7140` |
| `ProjectionDefinition` | 同上 | `6467-6469` |
| `register/stateOf/snapshot/checkpoint/restore/viewCheckpoint` | `dsh-session-projection/lib/index.js` | `68` / `126` / `141` / `195` / `286` / `243` |
| `snapshot` 只出 wire 单元 | 同上 | `146`、`173`、`248`、`304` |
| cell 惰性构建（折叠全量日志） | 同上 | `377-384`、`400-427` |
| `cachedSnapshot(meta, keys)` | `dsh-session-projection-cache/lib/index.js` | `192-197`、`226-237` |
| `hydratePrepared` 容错回落 | 同上 | `247-255` |
| 检查点三大必写点 | `dsh-session-projection-cache/README.zh.md` | `57` |
| `listSessions` / `observeSession` / `readSession` | `dsh-session-query/lib/index.js` | `95-118` / `1064` / `1081-1089` |
| 冷会话观测与投影计算 | 同上 | `350-397`、`477-514` |
| `sessionPersistence` 五个方法 | `dsh-session-persistence/README.zh.md` | `34-49` |
| `SessionPersistenceSnapshot` / `SessionHandle` | `api-catalog.js` | `7247` / `7119` |
| 磁盘布局 | `dsh-session-persistence-jsonl/README.zh.md` | `55-73`、`111`、`166` |
| `workspaceRegistry` 方法 | `api-catalog.js` | `3847-3912` |
| `Workspace` 实体 | 同上 | `8663-8664` |
| 会话按 cwd 归组规则 | `dsh-workspace/README.zh.md` | `71-73`、`93-97`、`170` |
| `defineDomain` / `domainTable` | `dsh-storage-domain/lib/index.js` | `46-48`、`61-76` |
| `Domain.table/global/close` | 同上 | `187` / `157-173` / `198` |
| 表句柄 get/entries/keys/put/update | 同上 | `241-279` |
| `UNIT_NAME_RE` | `dsh-storage/lib/index.js` | `80` |
| storage-json 落盘布局 | `dsh-storage-json/README.zh.md` | `36-56` |
| `useProjection` = keyed hook `projection` | `dsh-client-ui-session/lib/client.js` | `755-764` |
| prop 命名规则 | `dsh-client-ui-slots/lib/index.js` | `7-9` |
| keyed hook 调用形态/实现 | `dsh-client-ui-renderer/lib/client.js` | `245-264`、`270-287` |
| 投影 face 实现 | `dsh-api-session-controller/lib/types/client/sessions/projection-store.js` | `29-31`、`145-160` |
| 参考实现：路由包装 + 栅栏 | `dsh-whale-widget/lib/index.js` | `848-885`、`3*` 段 |
| 参考实现：会话聚合 | 同上 | `944-991` |
| 参考实现：订阅/清理 | 同上 | `1124-1136` |
| 参考实现：`.dshw-*` 落盘 | 同上 | `24`、`486-496`、`898-913` |
| 组合层：base 挂载 | `dsh-base/cordis.patch.yml` | `138-141`、`157-161`、`172-200` |
| 组合层：web-app 挂载 workspace | `dsh-web-app/cordis.patch.yml` | `91-92` |
| 本机 profile 实际 bundles（base + web-app 均在场） | `~/.dsh/profiles/desktop/package.json` | `20-22` |
| 服务注册名核对：`sessionQuery` / `sessionProjectionCache` / `workspaceRegistry` | `dsh-session-query/lib/index.js:1048` / `dsh-session-projection-cache/lib/index.js:146` / `dsh-workspace/lib/index.js:376` | — |

## 附录 B：明确"未找到"的点

1. **没有** `ctx.workspace` 这个服务名；是 `ctx.workspaceRegistry`。
2. **没有** `session.workspaceId` / `session.title` / `session.cwd`；对应的是 `session.header.cwd`，title 是投影 key。
3. **没有** 官方"每会话一份可读 JSONL"的读接口可以直接按行读：默认 zstd 且**多帧**；`compression: 'none'` 才可外部按行读（`dsh-session-persistence-jsonl/README.zh.md:166`），但那是部署级配置，改不了已存历史。
4. **没有** 官方"插件私有目录"约定；只有 `storages/<domain>`（storage-domain）与 `sessions/`（会话日志）。
5. **没有** `sessionProjections` 上"按 key 枚举所有会话"的方法；必须自己 `listSessions` 再逐个 `observeSession`（或先试 `sessionProjectionCache.cachedSnapshot(header)`）。
6. **未在产物里找到** `UseProjection` 的 .d.ts 声明（只找到用法与运行时装配）。上面 Q6.1 的四种调用形态是从 `keyedHookCall` 实现反推的 —— 前三形（`key`、`key+selector`、`key+selector+equal`）**有实现级证据**，`key+member` 形态也由 `keyedHookCall` 的字符串分支证实（`dsh-client-ui-renderer/lib/client.js:252-257`），但**没有官方文档描述**。**【推断】**
