# 本 fork 的改动（相对上游）

本文件是 **fork 维护者笔记**：记录本仓库相对上游 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 新增了什么、为什么这么设计、以及在哪些地方必须小心。玩家文档见 [README.md](../README.md)，协议与规则细节见 [design/network.md](design/network.md) §8.1。

- **基线**：上游 `master` = `bc50cac`（v0.2.4）。本 fork 从该提交分叉，上面所有游戏本体、规则、数值与上游文档**原样保留**。
- **上游态度**：上游在 [issue #268](https://github.com/sganggs/Stronghold-Protocol/issues/268) 明确「账号、公开大厅和另一套服务器……和项目已经定下的范围不同（**不做账号和云存档**）」，因此下面这些改动**不向上游提合并**，只在 fork 里维护。
- **同步上游**：`git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git`，之后定期 `git fetch upstream && git merge upstream/master`。账号改动集中在少数几个文件（见文末索引），冲突面可控。
- **可开关**：未配置账号存储（`ACCOUNTS_DIR`）时所有新逻辑不生效，行为与上游一致；不登录照样可以直接玩。

## 新增功能

### 1. 账号（可选）

账号有**两个名字**，从 2026-10-24 起分开（[shared/account.js](../shared/account.js)）：

- **账号 ID**：注册时由服务器生成的 `sp-…`，登录用它；**不能修改**。旧账号迁移时沿用原来的小写用户名作为 ID，所以老玩家仍用原来的名字登录。
- **用户名**：游戏内博士代号，**随时可以改**（`auth.rename`），**不再作为登录凭证**，也不再要求全服唯一（两个账号可以同名）。它可以是中文、空格等任意可显示文字，最长 24 个字符。

登录只发**一个长期 token，不再每次轮换**（换设备登录要接回原来的座位，就需要同一个凭证）。密码用 Node 自带的 scrypt 加随机盐。存档是 SQLite 数据库 `accounts.db`（Node 自带的 `node:sqlite`，不需要额外依赖；**Node ≥ 22.13**），**刻意放在仓库之外**（环境变量 `ACCOUNTS_DIR`，默认开服机器的用户目录），更新游戏 / 重新解压都不会动它。

数据库按行保存：一个账号一行，干员调配的编队项 / 潜能练度各一行，对局统计一条记录一行，设置与插件开关一份文档一行。每次写入只碰变化的行，并有外键、唯一约束与事务；崩溃由 WAL 保证不会写坏库。旧的 `accounts.json` 会在首次启动时**在一个事务里自动导入**，成功后改名为 `accounts.json.imported` 保留（不删）。旧文件损坏时不会静默当成空库：账号功能会停用并在启动日志里报错，原文件原样保留。

它**不是访问控制**，知道地址的人都能进来；服务器没有账号存储时相关帧一律为 no-op。代码：[server/accounts.js](../server/accounts.js)、[server/http/config.js](../server/http/config.js)、`auth.register` / `auth.login` / `auth.rename` / `auth.logout`（[shared/protocol.js](../shared/protocol.js)）。

### 2. 干员调配随账号同步

技能 / 模组、潜能 · 练度绑定账号，换设备、换浏览器或服务器重启都不会丢。**登录时账号副本优先**（先在 `auth.login` 的回复里把账号的 `loadout` / `ops` 放进本地，再进入游戏），这样紧随其后的同步是把账号那份发回去，而不是用本机副本覆盖账号；`server/lobby.js AccountStore.saveLoadout` 另外拒绝「账号本来为空 + 客户端推空」的写入，避免一个还没收到账号副本的会话把账号清空。代码：`server/lobby.js`（`accountHello`、`auth.*`）、[public/js/ui/loadoutSync.js](../public/js/ui/loadoutSync.js)。

### 3. 对局随账号走 + 账号隔离

- 座位绑定的是**稳定账号 ID**（不是用户名）而不是 token：同一个账号在另一台设备登录会**接管原座位**，并按重连路径还原进行中的对局（受与断线重连相同的时间窗限制：同盟 10 分钟、独立 24 小时；服务器重启后房间即结束）。改用户名不会换座位、不会换账号。
- **座位只还原给当初拿下它的账号**：别的账号在这个会话上登录时，先按「永久离开」释放原座位（客户端收到 `room.closed {reason:'account'}`），两个账号的对局数据不会互串；`auth.logout`（切游客）刻意保留 `session.accountKey`，座位仍属于那个账号。
- `welcome` 改为**先于**房间 / 对局状态重发，客户端的恢复宽限只认可其后的帧（`RESTORE_GRACE_MS`）——修掉了「重新登录后短暂显示对局界面又跳回选择界面」。

代码：`server/lobby.js`（`accountHello`、`dropForeignSeat`、`releaseForeignSeat`）、[server/net.js](../server/net.js)（`Session.accountKey` / `provisional`、`SessionRegistry.byAccountMap`、`sendWelcome`）、[public/js/net.js](../public/js/net.js)。

### 4. 游客登录提示

未登录点「开始」不再直接进游戏，先给一个告知弹窗（说明登录能同步干员调配、统计数据与对局），可以「以游客身份继续」，并有「不再提示」（记在本浏览器 `sp.pref.guestLoginNudge`）；不会把登录表单直接弹到脸上。代码：[public/js/screens/title.js](../public/js/screens/title.js)。

### 5. 账号失效不放行

服务器上的账号数据被清空（最典型：Docker 重建容器没挂 `ACCOUNTS_DIR` 卷）后，浏览器仍记得账号。登录态的 `hello` 不带代号，服务端对未知 token 按上游契约「惰性放行」，于是会按默认代号建一个游客会话——玩家看到「已登录、但昵称是博士」，实际是游客，干员调配与统计都没跟着账号走；标题页那条「该账号已登录，直接进入即可」的捷径还会直接把人放进这个会话。

客户端因此自己做判定：`hello` 带了账号而 `welcome` **没有** `accountName`，就认定凭证未被接受——丢弃失效 bearer（**保留用户名和账号 ID**给登录框预填）、不把服务端兜底的「博士」写进本机代号、`identity.setEntered(false)` 并清空房间 / 对局状态**退回标题页**，弹出「账号已失效」对话框，要求重新登录或注册（预填用户名、注册模式），也可以自己明确选择「以游客身份继续」。连接保持不断，`auth.login` / `auth.register` 会接管当前会话并改名。重新注册时客户端把本机记得的**账号 ID** 作为恢复提示带上（`auth.register.accountId`），服务器只在它还没被占用时采用它，于是本机的干员调配、统计数据和设置（都按账号 ID 归属）能传回新账号；ID 已被别人占用则返回 `ALREADY`，要求登录。

代码：[public/js/net.js](../public/js/net.js)（`_helloSentAccount`、`accountRejected`、`_forgetRejectedAccount`、`accountStore.forget` / `lastUsername` / `lastAccountId`）、[public/js/main.js](../public/js/main.js)（`onWelcome` 的 rejected 分支）、[public/js/screens/title.js](../public/js/screens/title.js)、[public/js/store.js](../public/js/store.js)（`ui.accountExpired`）。服务端未改（未知 token 仍然只是失效、不拒绝入场，`test/accounts.test.js`「an unknown token is inert」固定了这个契约）。

### 6. 对局统计同步

本机对局记录在登录后同步到账号：`stats.push` / `stats.pull` / `stats.clear`，`auth.result` 也会带上镜像，`stats.pull` 用 `stats.sync {stats, clearedAt}` 回复。账号镜像的规则：

- **只保留压缩汇总记录**（帧 + 自己那行的汇总，不含阵容 / 盟约 / 队友名），上限 **16 KB**（前后端一致：`server/stats.js STATS_MAX_BYTES` 与 `public/js/ui/stats.js SYNC_MAX_BYTES`）；本机保留完整历史，所以**从账号拉回的记录不能回看结算**，界面已写明。
- 合并按记录 id 取并集，完整记录胜过汇总记录；「清空」会写 `statsClearedAt` 戳记，另一台设备在下一次 pull 时丢掉被清掉的记录，而不是又推回来。
- 客户端**按摘要跳过重复上传**（`sp.pref.statsSync = {account, hash}`）：镜像有上限，「账号缺我的记录」对打得多的人恒为真，不能拿它当重推依据；账号镜像回空（被清 / 被换）时才强制重发。
- 发送时机：**等一次 pong 之后再延迟 400 ms**（客户端每 4 秒一次延迟探针，统计帧不排在 pong 前面，最多等 6 秒兜底）；**对局进行中不发**，延后重试。
- 归属：`sp.pref.statsOwner` 记录本机历史属于哪个**稳定账号 ID**——同一账号取并集，改用户名不改变归属；换账号则从该账号自己的副本开始（不收养别人的战绩），从未归属过的游客历史由第一个登录的账号收养；游客的记录永不上传。旧浏览器里这个键还是旧用户名，而旧账号的初始账号 ID 就是旧用户名，所以无需迁移。

代码：[server/stats.js](../server/stats.js)、[public/js/ui/statsSync.js](../public/js/ui/statsSync.js)、[public/js/ui/stats.js](../public/js/ui/stats.js)、[public/js/screens/stats.js](../public/js/screens/stats.js)。

### 7. 游戏设置、插件开关与房主插件配置同步

「设置」里的游戏设置（音量、语音语言、伤害数字、画质、文字大小、快捷键等）、玩家自己的插件开关（「设置 → 外观插件」「设置 → 界面插件」）以及**房主上次在「插件」面板里选的插件与插件参数**也随账号走：新设备登录后先应用账号副本，之后的修改防抖上传；账号还没有副本时，用这台浏览器的设置填上第一份。

- 协议只做加法：`settings.push {settings}` / `settings.pull`；`settings.pull` 用 `settings.sync {settings, updatedAt}` 回复，`auth.result` 也会带上 `settings` / `settingsUpdatedAt`，所以登录页在进入游戏前就能应用。
- 文档由客户端拥有（[shared/settingsSync.js](../shared/settingsSync.js)）：`{ v, game, plugins: { cosmetic[], ui[], room[{id, settings?}] } }`。服务端只校验信封、大小、插件 id 与标量参数，**不解释** `game` 里的字段；以后设置加字段不需要改服务端，版本不匹配时拒绝而不是误读。
- **整份文档最后写入者获胜**，不做逐字段合并：设置是偏好而不是战绩，两边的时钟也不足以来仲裁。账号副本在登录 / 每次 `welcome` 时优先；应用它时不会触发回传，避免「刚拉下来又推回去」。
- `plugins.room` 是**房主本人的偏好**，不是房间的实时内容：`room.setPlugins` 成功后由 [public/js/ui/pluginConfig.js](../public/js/ui/pluginConfig.js) 记下 id 与 manifest 参数；新建一个自己主持、尚无插件的房间时，用同一份 `room.setPlugins` 自动套用一次。它仍要经过服务器的插件策略 / 缺失检查，失败只记日志；房间的实时 `cs` / `vs` 与哈希不受这个文档影响。
- **不包含**界面插件自己的 `sp.plugin.<id>.` 命名空间——那是插件私有状态，不是本版本定义的设置。界面语言（`sp.pref.lang`）也保持本机：它有独立的语言包加载 / 重启语义，和设置文档分开。

代码：[public/js/ui/settingsSync.js](../public/js/ui/settingsSync.js)、[public/js/ui/pluginConfig.js](../public/js/ui/pluginConfig.js)、[public/js/ui/pluginPanel.js](../public/js/ui/pluginPanel.js)、[shared/settingsSync.js](../shared/settingsSync.js)、`server/lobby.js`（`settingsPush` / `settingsPull`）、`server/accounts.js`（`saveSettings` / `readSettings`）、`shared/protocol.js`、`public/js/screens/title.js`。

### 8. 干员皮肤随账号同步

外观插件提供的干员皮肤选择（`{ [charId]: skinId }`，docs/SKINS.md）也跟随账号：换设备登录后，账号里的皮肤选择会先应用到本机，再按正常的 `room.skins` 发给房间；在任一台设备上改皮肤，服务器会把结果写回账号。

- 存储：SQLite `accounts.skins_json`（schema v2；旧库启动时自动加列，无需手工迁移）。`null` 表示账号从未保存过，保留本机 / 游客的选择并由下一次 `room.skins` 写入；`{}` 表示玩家显式清空了所有皮肤，是真实值，登录时照样应用。
- 传输：`auth.result.skins`、`welcome.accountSkins`；`room.skins` 的处理里用 `session.accountToken` 写回账号。客户端在 `installSkinsSync` 发送前把账号副本放进 `skinsStore`，避免用旧的本机选择覆盖账号。
- 不改变 `room.skins` 的规则：选择仍是公开的（队友在 `m.public` 里看得到），房间没有的干员条目仍被 `checkSkinSelection` 丢弃，插件关闭 / 皮肤 id 不存在的回退仍由客户端处理。
- 账号里存的是原始选择，不校验“这台设备是否开了那个外观插件”；插件打开后选择自然恢复，关着时只是画不出来。

代码：[server/accounts.js](../server/accounts.js)（`skins_json`、`saveSkins` / `readSkins`）、[server/lobby.js](../server/lobby.js)（`accountHello` / `authLogin` / `skins` / `welcomeInfo`）、[public/js/screens/title.js](../public/js/screens/title.js)、[public/js/main.js](../public/js/main.js)、[public/js/ui/skins.js](../public/js/ui/skins.js)、[public/js/ui/loadoutSync.js](../public/js/ui/loadoutSync.js)（`installSkinsSync`）。

### 9. 延迟胶囊显示口径

胶囊量的是客户端自己 `ping`/`pong` 的往返，而这个往返是在页面主线程上按「收到时刻 − 发出时刻」算的，所以页面自己卡顿的时间也会被算成网络延迟（对局中本机要跑战斗模拟与渲染时尤其明显）。现在显示的是 **15 秒窗口内的最低往返**（`PING_WINDOW_MS`）：卡顿只会让单次采样偏大，取最小即链路延迟。`net.pingLast` 保留最近一次原始采样，控制台 `__SP__.net.ping`（显示值）/ `__SP__.net.pingLast`（含卡顿的原始值）可对照；死连接看门狗不受影响（它数的是发出后无人应答的 ping）。代码：[public/js/net.js](../public/js/net.js)、[public/js/ui/components.js](../public/js/ui/components.js)。

## 能不能把账号系统做成 0.3.0 插件？

**结论：按 0.3.0 冻结的插件 API 做不到，建议不做。** 评估（判据、九条耦合点、七个阻塞点、`service` 类草案、三条路线与推荐）见 [ACCOUNT-PLUGIN-FEASIBILITY.md](ACCOUNT-PLUGIN-FEASIBILITY.md)。一句话：0.3.0 里能跑服务器代码的只有 `trusted` 类，它只有 `http.route` / `lobby.on`（5 个只读事件）/ `health.extend` 三个接口，且默认关闭、要求 pin、**拒绝通配/公网监听地址**；而账号系统是「WS 帧 + 会话身份 + 进程内同步 token 查表 + 标题页 UI」，四件事都不在插件 API 的语义里。推荐路线 A：留在树内，把它重构成自包含模块 + 少量显式缝隙。

## 存储换成 SQLite（已实现）

账号存储现在是 SQLite（`server/accounts.js`，`node:sqlite`，无新依赖）：`accounts` / `loadout_entries` / `loadout_ops` / `stats_records` / `account_docs` 五张表，WAL + 单事务写入，`accounts.json` 首次启动自动导入并保留为 `accounts.json.imported`。详细设计与当时的取舍见 [ACCOUNT-SQLITE-DESIGN.md](ACCOUNT-SQLITE-DESIGN.md)（§6 的不变量表就是验收清单；实现与提案的差异只有 `ops_saved` 与 `account_docs` 两处，见文末「实现说明」）。

**回滚**：数据库是唯一真相。回滚到旧版本前，先把库导出成旧版的 `accounts.json` 形状（见 [ACCOUNT-SQLITE-DESIGN.md](ACCOUNT-SQLITE-DESIGN.md) §7）；旧版本不认 `accounts.db`。**不要**在运行中只拷 `accounts.db` 主文件：最新的写入在 `-wal` / `-shm` 里；停服后三个文件一起拷，或用 SQLite 的 `.backup`。

## 运维：Docker 必须挂账号目录

镜像里 `accounts.db`（+ `-wal` / `-shm`）在容器的可写层（Dockerfile 结尾是 `USER node`，所以是 `/home/node/data/accounts.db`），**`docker rm` + 重新 `docker run` 就等于清空账号**。重建容器时必须：

- `-e ACCOUNTS_DIR=/data -v <宿主机目录>:/data`，并把宿主机目录 `chown 1000:1000`（否则服务端打不开库：表现为启动日志里的 `[accounts] disabled`，账号改了也留不下来）；
- **不要把 `ACCOUNTS_DIR` 放在 NFS / SMB 等网络盘上**：WAL 依赖的共享内存与锁在这些文件系统上不可靠（旧的单文件写法没有这个限制）；
- 从旧容器迁移时：`docker cp stronghold:/home/node/data/accounts.json ./accounts-backup.json`；新版第一次启动会把它导入，成功后改名为 `accounts.json.imported`。也可以直接把旧 `accounts.json` 放进新容器的 `ACCOUNTS_DIR` 再启动。
- 备份：停服后拷 `accounts.db`、`accounts.db-wal`、`accounts.db-shm`；运行中请用 `sqlite3 accounts.db ".backup 'accounts-backup.db'"`（或 `VACUUM INTO`），不要只拷主文件。

真丢了也不会把人挡在门外，但也不会糊弄过去：玩家端会弹「账号已失效」并要求重新登录 / 注册（见第 5 节）。细节见 [DEPLOY.md](DEPLOY.md) §3。

## 与上游保持一致的地方（改这里要小心）

- **未知 / 失效 token 仍然只是「失效」**：服务端不拒绝入场，`welcome` 不带 `accountName` 就是客户端唯一的判定信号（第 5 节）。改服务端这一行为会连带改客户端判定。
- **协议只做加法**：新增 `auth.*`、`stats.*` 与 `settings.*`，`PROTOCOL_VERSION` 不变，上游客户端连上来仍能正常玩（只是没有账号功能）。
- **`welcome` 与 resync 的顺序**是硬约束（第 3 节），不要为了让状态更早到而调换。
- 战斗规则、数值、`data/*.json`、`server/sim/` 一律不碰；统计与账号都在 `server/` 之外的层次。

## 代码位置索引

| 关注点 | 文件 |
|---|---|
| 账号存储（SQLite / scrypt / token / 迁移） | `server/accounts.js`、`server/http/config.js` |
| 账号 ID / 用户名规则 | `shared/account.js`、`public/js/net.js`（accountStore）、`public/js/screens/title.js`、`public/js/ui/settings.js` |
| 会话与座位隔离、auth.* / stats.* / settings.* 处理 | `server/lobby.js`、`server/net.js`、`server/http/websocket.js`、`shared/protocol.js` |
| 统计镜像与上限 | `server/stats.js` |
| 设置 / 插件开关 / 房主插件配置文档 | `shared/settingsSync.js`、`public/js/ui/settingsSync.js`、`public/js/ui/pluginConfig.js`、`public/js/ui/pluginPanel.js`、`public/js/screens/title.js` |
| 客户端账号状态与传输 | `public/js/net.js`、`public/js/main.js`、`public/js/store.js` |
| 标题页账号 UI / 游客提示 / 账号失效弹窗 | `public/js/screens/title.js`、`public/css/screens/title.css` |
| 调配与统计同步 | `public/js/ui/loadoutSync.js`、`public/js/ui/stats.js`、`public/js/ui/statsSync.js`、`public/js/screens/stats.js` |
| 测试 | `test/accounts.test.js`、`test/accounts-settings.test.js`、`test/accounts-roundtrip.test.js`、`test/accounts-stats.test.js`、`test/lobby-skins.test.js`、`test/ui/settingsSync.test.js`、`test/ui/pluginConfig.test.js`、`test/ui/stats.test.js`、`test/ui/statsSync.test.js`、`test/client-static.test.js` |
| 设计说明 | `docs/design/network.md` §8.1、`docs/design/client.md` |