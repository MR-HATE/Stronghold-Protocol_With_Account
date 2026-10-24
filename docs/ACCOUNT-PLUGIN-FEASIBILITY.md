# 账号与同步系统「插件化」可行性评估

> **本文只做评估，不改任何代码。** 它回答一个问题：能不能用 0.3.0 新出的插件系统（`plugins/<id>/`，见
> [PLUGINS.md](PLUGINS.md)）把本 fork 的账号与同步系统改写成插件？如果不能，差在哪里，需要补什么，以及在不改
> 上游的前提下更划算的做法是什么。
>
> **后续变化**：账号存储已换成 SQLite（`accounts.db`，见 [ACCOUNT-SQLITE-DESIGN.md](ACCOUNT-SQLITE-DESIGN.md)），
> 同步内容增加了设置与个人插件开关；这些都不改变本文的结论（插件 API 仍没有 WS 帧 / 会话身份 / 同步查表的位置）。
>
> 相关文档：[FORK_NOTES.md](FORK_NOTES.md)（本 fork 相对上游的全部改动）、[PLUGINS.md](PLUGINS.md)（插件系统的参考）、
> [design/network.md](design/network.md) §8.1、[docs/history/0.3.0.md](history/0.3.0.md)（0.3.0 的设计与阶段）。

## 0. 结论摘要

- **判定：按 0.3.0 冻结的插件 API，做不到。** 这不是工作量问题，而是插件系统**没有承载这个功能的接口面**。
- **一句话证据**：0.3.0 里能跑服务器端代码的只有 `trusted` 类，它对外只有三样东西 —— `api.http.route()`、
  `api.lobby.on()`（5 个只读事件）、`api.health.extend()`（[trustedEntry.js](../server/plugins/trustedEntry.js#L13-L23)）。
  而账号系统是「WebSocket 帧 + 会话身份 + 进程内同步 token 查表 + 标题页 UI」四件事，一件都不在插件 API 的语义里。
- **强行走插件的代价**：需要先给插件系统新增一类能力面（本文 §5 的 `service` 草案），工程量**大于账号系统本身**；
  按仓库硬规则，插件面每个版本冻结、新增成员要走 DESIGN / PLUGINS.md / PLUGIN-API.md / schema / 错误码目录 / i18n
  全套，属于维护者决策。而且上游在 issue #268 明确「不做账号和云存档」（[FORK_NOTES.md](FORK_NOTES.md)），新类
  只能由 fork 自己背 —— **分歧没有消失，只是从「16 个文件里的小改」搬成「插件系统里的一处大改」**。
- **推荐：路线 A**（§6）——留在树内，把账号系统重构成自包含模块 + 少量显式缝隙，把可见耦合从
  **16 个上游文件、130 个 diff hunk** 收敛到一张明确的钩子表；插件化等上游真的提供 service 类时再谈。

## 1. 判据：什么才算「做成插件」

先立标准，否则「插件化」会退化成「换个目录放代码」。要算成功，必须同时满足：

| # | 判据 | 说明 |
|---|---|---|
| J1 | 可安装 / 可卸载 | 只增删 `plugins/<id>/`，不改别的文件 |
| J2 | 不改上游文件 | `git diff upstream/master` 只剩 `plugins/`、文档与本 fork 的 README |
| J3 | 行为等价 | 现有账号 / 同步测试全绿，协议只做加法，打包与 i18n 不变 |
| J4 | 安全不降级 | 口令与长期 bearer 的处理不弱于现状（不得把凭证挪到 URL、不得明文落盘） |
| J5 | 默认关闭即上游 | 没配账号时行为与上游完全一致（今天的 `ACCOUNTS_DIR` 就是这个语义） |

## 2. 现状盘点：要搬的到底是什么

### 2.1 组成与体量（相对 `upstream/master`）

| 层 | 文件 | fork 增量 |
|---|---|---|
| 账号存储 | [server/accounts.js](../server/accounts.js) | 新增 313 行（scrypt + 盐、长期 token、`accounts.json` 原子写） |
| 统计镜像 | [server/stats.js](../server/stats.js) | 新增 97 行（按 id 取并集、16 KB 上限、`statsClearedAt`） |
| 协议 | [shared/protocol.js](../shared/protocol.js#L434-L452)、[shared/constants.js](../shared/constants.js) | +43/−4、+17（新帧与常量，`PROTOCOL_VERSION` 不变） |
| 服务端会话 | [server/lobby.js](../server/lobby.js#L732-L760)、[server/net.js](../server/net.js#L694-L851)、[server/http/websocket.js](../server/http/websocket.js#L71-L82)、[server/http/config.js](../server/http/config.js#L29-L40) | +248/−11（14 hunk）、+179/−21（26 hunk）、+23/−6、+17 |
| 客户端 | [public/js/net.js](../public/js/net.js)、[public/js/main.js](../public/js/main.js)、[public/js/store.js](../public/js/store.js)、[public/js/screens/title.js](../public/js/screens/title.js) | +199/−11（19 hunk）、+32、+1、+251（13 hunk） |
| 客户端同步 | [public/js/ui/loadoutSync.js](../public/js/ui/loadoutSync.js)、[public/js/ui/statsSync.js](../public/js/ui/statsSync.js)、[public/js/ui/stats.js](../public/js/ui/stats.js)、[public/js/screens/stats.js](../public/js/screens/stats.js) | +42、新增 206、+171、+20 |
| i18n | `public/i18n/{zh,en,ja,ko,zh-TW}.json` | 每个语言包数十行新文案 |
| 测试 | `test/accounts*.test.js`、`test/ui/statsSync.test.js`、`test/ui/stats.test.js`、`test/client-static.test.js` | 新增 / 修改 |

合计：**52 个文件、+3780/−132**，其中 **16 个是上游自有文件、共 130 个 diff hunk**。

### 2.2 与游戏本体的耦合点（这些才是关键）

| # | 耦合点 | 现在的实现 | 插件能不能碰到 |
|---|---|---|---|
| C1 | intent 分发 | `auth.register` / `auth.login` / `auth.logout` / `stats.push` / `stats.pull` / `stats.clear` 进 net.js 的意图表与验证器（[protocol.js](../shared/protocol.js#L434-L452)、[net.js](../server/net.js#L694-L751)） | ✗ 插件没有注册 intent 的入口 |
| C2 | hello 时的同步 token → 座位 | `net.js` 在铸造会话**之前**同步调用 `handler.sessionForAccount(account)`（[net.js](../server/net.js#L792)），底层是 `AccountStore.lookupToken()` 的内存 Map | ✗ 插件跑在另一个子进程，同步查表要 IPC |
| C3 | 「用户名就是代号」 | 登录态的 `hello` 不带 `name`，由服务端解析并改名（[lobby.js](../server/lobby.js#L732-L760)；当时登录也用用户名，现已改为稳定账号 ID） | ✗ 无法改会话的 `name` |
| C4 | `welcome` 顺序 | `welcome` 先于房间 / 对局状态重发（[FORK_NOTES.md](FORK_NOTES.md) 第 3 节） | ✗ 无法介入握手时序 |
| C5 | 座位归属与隔离 | `SessionRegistry.byAccountMap`、`dropForeignSeat` / `releaseForeignSeat`、`room.closed {reason:'account'}`（[lobby.js](../server/lobby.js#L762-L790)、[net.js](../server/net.js#L182-L248)） | ✗ 无法绑定 / 释放在场会话 |
| C6 | 干员调配落盘 | `lobby.js` 在 `room.loadout` 处理里把 `loadout`/`ops` 写进账号 | ✗ 无法拦截其它 intent |
| C7 | 统计屏与节流 | `stats.push/pull/clear` + 客户端摘要跳过、安静窗口、`welcome` 携带镜像 | ✗ 同上 |
| C8 | 标题页 UI | 登录 / 注册 / 游客提示 / 账号失效弹窗（[title.js](../public/js/screens/title.js) 内 77 处相关代码） | ✗ 见 §3.3 |
| C9 | 启动预热 | 服务启动时 `await accounts.load()`（[websocket.js](../server/http/websocket.js#L71-L82)），保证 hello 时表已在内存 | ✗ 子进程生命周期与之一致性无法保证 |

**这九条里有七条是「协议 / 会话身份」层面的**，而插件系统在 0.3.0 里对协议层是完全不可见的：插件不参与握手、
不注册 intent、不见 socket。

## 3. 0.3.0 插件系统实际提供了什么

### 3.1 类与用途（[PLUGINS.md](PLUGINS.md) §2 的表）

| 类 | 承载 | 0.3.0 状态 | 对本功能的可用性 |
|---|---|---|---|
| `lang` | 语言包 | 已加载 | 无关 |
| `cosmetic` | 美术 / 音频 | 已加载 | 无关 |
| `content` | 数据补丁 / 新记录 | 已加载（房间内容组合 `cs`） | 无关（账号是服务器级、跨房间，不是房间内容） |
| `script` | 战斗 / 对局的代码 | 默认关闭（沙箱 / 受信任） | 无关（只作用于 sim 与 meta） |
| `ui` | 沙箱 iframe 里的界面挂件 | 已加载 | **不可用**，见 §3.3 |
| `trusted` | 完整信任的页面或服务器代码 | 默认关闭，需 pin + 同意 | 部分可用，见 §3.2 |

### 3.2 `trusted` 服务器入口的全部 API

[trustedEntry.js](../server/plugins/trustedEntry.js#L13-L23) 里冻结给插件的 `api`，只有：

1. `api.http.route('/x/<id>/…', fn)` —— 路径必须落在 `/x/<插件 id>/` 下；handler 收到**冻结的 `{ method, path, url }`**；
   返回一个 JSON 值（[trustedRuntime.js](../server/plugins/trustedRuntime.js#L77-L88)）。
2. `api.lobby.on(event, fn)` —— 只接受 `roomCreated` / `playerJoined` / `playerLeft` / `matchStarted` / `roomClosed`，
   收到的是**冻结副本**，只能看不能答。
3. `api.health.extend(value)` —— 每个插件最多 16 KiB JSON，挂到 `/healthz`。

配套限制：所有 trusted server 入口共用**一个** fork 出来的子进程（`--max-old-space-size=128`），激活超时 5 秒、
每个请求超时 5 秒，任一超时 / 崩溃即 SIGKILL 清空全部路由（[trustedRuntime.js](../server/plugins/trustedRuntime.js#L8-L44)）。

### 3.3 `ui` 类插件（客户端）的能力边界

- 运行在 `<iframe sandbox="allow-scripts">`，**不透明源**，读写不到本页的存储与凭证；响应头带
  `connect-src 'none'`（[PLUGINS.md](PLUGINS.md) §14）。
- 宿主**绝不**把插件的消息变成 client→server 的消息；插件也不能发 `hello` / `room.*` / `g.*` / `b.*`
  （[PLUGINS.md](PLUGINS.md) §14 的「The feed」）。
- 槽位是**封闭集合**：`hud.right`、`result.tab`、`stats.tab`、`room.panel`
  （[manifest.js](../shared/plugins/manifest.js#L201)）—— **没有标题页槽位**，而登录入口正在标题页。
- 它收到的 public / private 子集是白名单裁剪的，private 明确丢掉 `tokens`、`loadout`、`ops`、`diy`
  （[ui.js](../shared/plugins/ui.js#L344-L358)）。

### 3.4 存储

插件 API **没有**任何服务器端持久化：`accountStore` / `accounts.json` 无处安放。唯一近似物是 ui 插件的客户端
`localStorage` 命名空间（`sp.plugin.<id>.`，每插件 ≤ 32 KB），与服务器账号库毫无关系。

## 4. 阻塞点（B1–B7）

| # | 需求 | 插件现状 | 证据 | 影响 |
|---|---|---|---|---|
| **B1** | 注册 / 应答 `auth.*`、`stats.*` 帧 | 无 intent 缝隙；`lobby.on` 只有 5 个只读事件 | [trustedEntry.js](../server/plugins/trustedEntry.js#L18-L21)、[net.js](../server/net.js#L694-L751) | 登录、同步、清空全部无法实现 |
| **B2** | 读取请求 body / header | handler 只拿到 `{method,path,url}` | [trustedRuntime.js](../server/plugins/trustedRuntime.js#L84) | 口令与 bearer 只能塞 URL query → 违反 J4 |
| **B3** | 标题页登录 UI | ui 插件无网络、无 intent、槽位不含标题页 | [PLUGINS.md](PLUGINS.md) §14、[manifest.js](../shared/plugins/manifest.js#L201)、[title.js](../public/js/screens/title.js) | 玩家无处登录 |
| **B4** | 在进入房间前就生效的页面代码 | `trusted.page` 需 room scope + 每人同意 + 带 `?cs&room` 重载 | [PLUGINS.md](PLUGINS.md) §13 的「Experimental trusted class」 | 与「登录发生在进房之前」时序矛盾 |
| **B5** | 默认可用 | `trusted` 需 `SP_PLUGIN_SCRIPTS=trusted` + `plugin.lock.json` 的 SHA-256 pin；**通配 / 公网监听地址直接拒绝执行** | [trusted.js](../server/plugins/trusted.js#L47-L57) | 默认部署（监听 `0.0.0.0`）上账号功能静默失效；这正是账号最需要工作的场景 |
| **B6** | 持久化 + 同步查表 | 无存储 API；trusted 入口在独立子进程，而 `hello` 里的 token→座位是同步内存查表 | §3.4、[net.js](../server/net.js#L792) | 存储与握手契约同时被打断 |
| **B7** | 语义归属 | 插件的一切都挂在 `cs`（房间内容组合）上；账号是**服务器级、跨房间、跨对局**的个人服务 | [PLUGINS.md](PLUGINS.md) §6、§11 | 「个人服务」在这个模型里没有位置，非官方标记 / 统计总览排除也无处表达 |

> 附注：B5 是**部署级**阻塞——即使前面几条都被绕过，一个监听 `0.0.0.0` 的服务器上这个插件也不会被加载。

## 5. 如果一定要插件化：需要给插件系统补什么（`service` 类草案）

以下只是设计草案，用于估算，不代表建议实施。核心是承认：**账号系统需要的是一类全新的插件形态**，不是现有
六类中的任何一类的变体。

### 5.1 类与清单

```jsonc
{
  "manifest": 2, "id": "account-sync", "class": "service",
  "scope": ["server"],                      // 服务器级，与房间无关
  "permissions": ["service.http", "service.storage", "service.session", "service.client"],
  "entry": { "server": "server/index.js", "client": "client/panel.js" }
}
```

### 5.2 需要新增的 API 面

| 能力 | 现状 | 需要新增 |
|---|---|---|
| 请求完整性 | 只有 `{method,path,url}` | `{ method, path, url, headers, body(限长), remoteAddress }` + 响应控制（状态码、cookie、CSP） |
| 协议介入 | 无 | `api.session.onIntent(name, fn)`：注册并应答非房间 intent；`api.hello.before(fn)`：能在 `welcome` 之前改名 / 拒绝；`api.session.bind(key, session)` 与释放钩子 |
| 持久化 | 无 | `api.store`：JSON、限长、原子写、按插件隔离、目录在仓库外（与 `ACCOUNTS_DIR` 的语义对齐） |
| 客户端挂载 | 槽位封闭集合，无标题页 | 新增标题页挂载点 + **允许同源 fetch / WS 的受控通道**（ui 帧的 `connect-src 'none'` 与「无 intent」决定了它不能用于登录） |
| 信任门 | 默认关闭、pin、拒绝通配监听 | 需要新门：既然账号只能在远程部署上有意义，「拒绝通配监听」这条对 service 类必须重新决策 [ASSUMED] |
| 规范面 | —— | `PLUGIN_CLASSES` / `PERMISSIONS` / schema / 错误码目录 / PLUGIN-API.md 冻结表 / DESIGN 与 history / i18n 全部要动 |

### 5.3 粗估

对照 0.3.0 自己的 P3a（受信任执行）与 P3b（沙箱）两个阶段，这个 `service` 类至少拆成四步：API 与 IPC 面 →
存储 → 客户端挂载与通道 → 安全门与文档。规模 **≥ 账号系统本身**（后者是 3780 行、52 个文件），而且它触及的是
插件系统的核心不变量（默认关闭、房间隔离、`cs` 归属）。**结论：这条路的第一阶段应该是设计文档与维护者决策，
不是编码。**

## 6. 三条路线对比

| | A：留在树内，重构成自包含模块 + 显式缝隙 | B：先扩插件系统（`service` 类），再迁移 | C：只把边角做成插件 |
|---|---|---|---|
| 真正插件化 | 否（但走的是「内部扩展」路线） | 是 | 部分 |
| 消除 fork 分歧 | 部分：耦合收敛到钩子表，合并冲突可控 | 名义上彻底；但新类只能 fork 自己背 → 分歧转移到插件系统 | 否 |
| 工作量 | 中（重构，无新功能） | 大（≥ 现有账号系统） | 小 |
| 风险 | 低（行为不变，测试可逐条对照） | 高（协议面 + 安全门 + 存储语义都要新建） | 低 |
| 需不需上游 / 维护者决策 | 不需要 | **需要**（插件面冻结，新增成员是维护者决策） | 不需要 |
| 对现有测试 | 全绿（对照运行） | 前期不动，迁移期大面积重写 | 不影响核心 |
| 玩家可见收益 | 无（但合并上游更便宜） | 与今天相同 | 几乎没有 |

**推荐 A**：它解决 fork 真正的痛点（长期跟随上游），不引入新的不可控面，也不把「登录能不能用」绑在一条默认关闭
且拒绝通配监听的信任门上。

## 7. 路线 A 的做法（若采纳）

### 7.1 目标布局

- `server/accounts.js`、`server/stats.js`：保持纯存储，去掉对 lobby/net 的任何知识（今天已经基本如此）。
- 新增 `server/account/service.js`：账号功能的**门面**，暴露 `attach({ registry, lobby, network, log })`，把
  intent 处理、座位绑定、loadout / stats 落盘都收在这里；`websocket.js` 只负责构造并按需 `attach`。
- 客户端新增 `public/js/account/`：`panel.js`（标题页 UI 与流程）、`sync.js`（loadout + stats 的推送编排、
  摘要与安静窗口）。`main.js` / `title.js` 只保留一个挂载点。

### 7.2 需要在上游文件里保留的最小钩子（草案）

| 位置 | 今天做了什么 | 目标缝隙形态 | 备注 |
|---|---|---|---|
| [net.js](../server/net.js#L694-L751) | 在意图处理里内联 `auth.*` / `stats.*` 分支 | 一张可注册的 intent 表（`handler.intents`） | 与 `HEAVY_TYPES` 的登记一起走 |
| [net.js](../server/net.js#L792) | `handler.sessionForAccount?.(account)` | 保持（已经是可选钩子） | 无需新面 |
| [net.js](../server/net.js#L763-L821) | hello 允许缺 `name` + 携带 `account` | 保持（`account` 已是可选字段） | 无需新面 |
| [lobby.js](../server/lobby.js#L732-L760) | `accountHello` 改会话名、绑座位 | 保持为可注入回调或 `service.attach` 注册 | |
| [lobby.js](../server/lobby.js#L850-L890) | `auth.*` / `stats.*` 的实现 | 移入 `server/account/service.js` | 这是最大的一块搬迁 |
| [lobby.js](../server/lobby.js#L1335-L1336) | loadout 落盘 | 观察者回调 | |
| [websocket.js](../server/http/websocket.js#L71-L82) | 构造并 `await accounts.load()` | 改为 `attach` 时预热 | |
| [main.js](../public/js/main.js)、[title.js](../public/js/screens/title.js) | 账号 UI 与流程散在里面 | 一个 `window.__SP__.account` 挂载点 | 客户端收敛的最大头 |

目标：上游文件里的**可读改动**压到每处几行、总 hunk 数从 130 降到 ~30 以内，且每处都能一句话说清用途。

### 7.3 验收标准

- `node --test test/accounts.test.js test/accounts-roundtrip.test.js test/accounts-stats.test.js test/ui/statsSync.test.js test/ui/stats.test.js test/lobby.test.js`
- `npm run ci`（含 lint / imports / types）
- `npm run golden`：**必须不变**（本文涉及的一切都在 `server/sim/` 之外）
- `node tools/package.mjs --dry-run`：打包与玩家文档链接仍然通过
- 若上游合并：`git merge upstream/master` 的冲突应集中在 §7.2 的那几行

### 7.4 明确不做

不碰战斗规则、数值、`data/*.json`、`server/sim/`；不改 `PROTOCOL_VERSION`；不把账号相关文案从四套语言包里拆出去。

## 8. 需要维护者 / 上游决策的问题

1. 上游 issue #268「不做账号和云存档」的立场是否仍然有效？若无效，正确的做法是**直接向上游提账号功能**，而不是
   把它塞进插件系统。
2. 若走 B：`service` 类是否向上游提交？不提交 = 分歧从游戏代码转移到插件系统；提交 = 需要上游接受「服务器级、
   跨房间的个人服务」这一全新插件形态。
3. 信任门：service 类能否在通配 / 公网监听的默认部署上运行？若不能，账号功能在所有真实部署上默认不可用。
4. 非官方标记与统计归属：账号同步的是**玩家数据**而非对局内容，是否要打 `MODDED` / 是否计入统计总览？
5. 客户端是否为插件开一个**标题页**挂载点？开了就等于承认插件可以接触登录态页面。
6. 插件存储放哪、如何备份？与今天 `ACCOUNTS_DIR`（刻意在仓库之外，见 [server/http/config.js](../server/http/config.js#L29-L40)）
   的语义必须一致，否则 `git pull` / 解压更新会动到账号数据。

## 附录 A：证据索引

| 结论 | 位置 |
|---|---|
| trusted 服务器插件只有三个 API | [server/plugins/trustedEntry.js](../server/plugins/trustedEntry.js#L13-L23) |
| 路由 handler 只见 method/path/url | [server/plugins/trustedRuntime.js](../server/plugins/trustedRuntime.js#L77-L88) |
| 单子进程 / 128 MB / 5 秒超时 | [server/plugins/trustedRuntime.js](../server/plugins/trustedRuntime.js#L8-L44) |
| 信任门：默认关闭、pin、拒绝通配监听 | [server/plugins/trusted.js](../server/plugins/trusted.js#L47-L57) |
| ui 插件的沙箱、CSP、无 intent | [docs/PLUGINS.md](PLUGINS.md) §14 |
| 界面插件槽位封闭集合（无标题页） | [shared/plugins/manifest.js](../shared/plugins/manifest.js#L201) |
| ui 帧的 private 子集丢掉 tokens/loadout/ops | [shared/plugins/ui.js](../shared/plugins/ui.js#L344-L358) |
| 账号帧与校验 | [shared/protocol.js](../shared/protocol.js#L434-L452) |
| hello 里的同步 token → 座位 | [server/net.js](../server/net.js#L792) |
| 账号即代号、座位隔离 | [server/lobby.js](../server/lobby.js#L732-L790) |
| 存储目录刻意在仓库之外 | [server/http/config.js](../server/http/config.js#L29-L40) |
| 启动预热账号库 | [server/http/websocket.js](../server/http/websocket.js#L71-L82) |

## 附录 B：复现本文的统计

```bash
git diff --stat upstream/master...HEAD
git diff --numstat upstream/master...HEAD
for f in $(git diff --name-only upstream/master...HEAD); do
  echo "$f $(git diff -U0 upstream/master...HEAD -- "$f" | grep -c '^@@')"
done
git log --oneline upstream/master..HEAD
```
