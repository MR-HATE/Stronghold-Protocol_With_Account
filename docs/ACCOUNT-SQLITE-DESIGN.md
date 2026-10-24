# 账号存储换成 SQLite（方案 B：行粒度）—— 详细设计

> **状态：提案，未实现。** 本文只描述改法、取舍、测试与工作量，不改动任何代码。批准后按 §10 的顺序落地。
> 相关：今天的实现见 [server/accounts.js](../server/accounts.js)（313 行，`accounts.json` 全量重写）；
> 协议与规则见 [design/network.md](design/network.md) §8.1；fork 改动清单见 [FORK_NOTES.md](FORK_NOTES.md)。

## 0. 一句话

把"一个账号一条 JSON 记录"换成"**一个账号一行、一个调配项一行、一场对局一行**"，
让每次写入只触碰变化的行；记录的**内部**仍是客户端给的 JSON，服务端不解释、不拍平。

## 1. 范围

| 做 | 不做 |
|---|---|
| 存储层换成 SQLite（`node:sqlite`，无新依赖） | 协议（`auth.*` / `stats.*` / `hello.account`）一个字节都不改 |
| `AccountStore` 的公开方法与返回形状保持不变 | 客户端（`public/js/`）不改，`localStorage` 的形状不改 |
| 调配项、统计记录各占一行 | 不把统计记录**内部的字段**拆成列（§2 说明为什么） |
| 一次性从 `accounts.json` 导入 + 保留备份 | 不加密码策略、找回、设备列表、限流（账号仍然"不是访问控制"） |
| 备份/导出工具、文档 | 不碰 `server/sim/`、`data/*.json`、golden、`PROTOCOL_VERSION` |

## 2. 关键判断：B ≠ 把记录拍平成列

这是整个设计里最容易做错的一步，先钉住。

[server/stats.js](../server/stats.js) 的头部写明了一条立场：**记录的模式属于客户端**。服务端只读三个字段——
`id`（并集键）、`t`（排序）、`compact`（"完整记录赢过压缩记录"的平手规则），其余原样存、原样还。
客户端那条 [normalizeRecord](../public/js/ui/stats.js) 是严格模式：未知字段被丢弃、每个字符串和列表都有上限、
还带着自己的 `MIGRATIONS` 版本链。

所以如果 B 把一条记录展开成 `difficulty / victory / roundsPassed / players(lineup...) / bonds(...) / stats(...)`
这些列，就等于**在服务端复制一份客户端拥有的模式**，而且必须跟着客户端的每一次迁移改：客户端加一个字段、
改一次上限、走一步 `MIGRATIONS`，服务端就要跟一次，还要处理"旧服务端读到新客户端的数据"。
这正是 [stats.js:4-7](../server/stats.js#L4-L7) 明确拒绝的事，也是今天"未知字段透传"能成立的原因。
收益（能按 `difficulty` 聚合）远小于代价，**第一批不做**。要查就加派生列，见 §9 的 B+。

所以 B 的"行粒度"是**写入粒度**，不是"字段粒度"：

```
一个账号        →  accounts            1 行
一项干员调配    →  loadout_entries     1 行 / 编队项
一项潜能·练度   →  loadout_ops         1 行 / 干员
一场对局        →  stats_records       1 行（记录 JSON 原样放 json 列）
```

只有调配那两张表是真正结构化的，因为那份模式**是服务端自己的**：[checkLoadout](../shared/protocol.js#L148)
和 [checkLoadoutOps](../shared/protocol.js#L248) 已经在收包时重建了 `{skill, module}` / `{potential, cultivate}`，
未知字段本来就会在入口被丢掉——存成列不损失任何信息。

## 3. 数据模型

打开库时按顺序执行（`PRAGMA user_version = 1`，见 §7 的迁移）：

```sql
PRAGMA journal_mode = WAL;      -- 读写不互斥；崩溃安全交给 WAL，不再靠 write-temp+rename
PRAGMA synchronous  = NORMAL;   -- WAL 下的标准选择：掉电最多回退最后几个事务，不会损坏库
PRAGMA busy_timeout = 5000;     -- 第二个连接（测试里会开）等锁，而不是立刻 SQLITE_BUSY
PRAGMA foreign_keys = ON;       -- 删账号时调配/统计跟着走

CREATE TABLE accounts (
  user_key         TEXT PRIMARY KEY,      -- 小写用户名：今天 Map 的 key，所有查找都走它
  name             TEXT NOT NULL,         -- 注册时的拼写 = 游戏内代号（不能被小写掉）
  salt             TEXT NOT NULL,
  hash             TEXT NOT NULL,
  hash_scheme      TEXT NOT NULL DEFAULT 'scrypt-16384-8-1',  -- 让以后的代价参数可读、可升级
  token            TEXT UNIQUE,           -- 一个账号一个长期 bearer；NULL = 还没有（老数据/被手工删掉）
  loadout_saved    INTEGER NOT NULL DEFAULT 0,  -- 0 = 从未保存过调配；区分 loadout 的 null 与 {}
  stats_v          INTEGER,               -- 统计镜像的信封版本 = STATS_VERSION；NULL = 没有镜像
  stats_cleared_at INTEGER,               -- 上次「清空统计数据」的时间戳
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER NOT NULL,
  extra_json       TEXT                   -- 本版本不认识的字段，原样透传（§5 第 13 条）
);

CREATE TABLE loadout_entries (
  user_key  TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
  chess_id  TEXT NOT NULL,                -- chess 记录 id（checkLoadout 已校验）
  skill     INTEGER NOT NULL CHECK (skill >= 0),
  module    TEXT,                         -- NULL = 没有/不用精英模组
  PRIMARY KEY (user_key, chess_id)
);

CREATE TABLE loadout_ops (
  user_key   TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
  char_id    TEXT NOT NULL,               -- 干员 charId（checkLoadoutOps 已校验）
  potential  INTEGER NOT NULL CHECK (potential BETWEEN 1 AND 6),   -- POTENTIAL_DEFAULT = 6
  cultivate  INTEGER NOT NULL CHECK (cultivate BETWEEN 0 AND 3),   -- CULTIVATE_DEFAULT = 3
  PRIMARY KEY (user_key, char_id)
);

CREATE TABLE stats_records (
  user_key   TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
  record_id  TEXT NOT NULL,               -- 并集键：1..64 字符（server/stats.js recordId）
  t          INTEGER NOT NULL,            -- 排序键（记录的 t；缺失时 0）
  seq        INTEGER NOT NULL,            -- 首次插入的序号：t 相同时的顺序 = 今天的 Map 插入顺序
  json       TEXT NOT NULL,               -- 记录原文。服务端从不解释（§2）
  PRIMARY KEY (user_key, record_id)
);

CREATE INDEX stats_by_time ON stats_records (user_key, t DESC, seq);
```

设计说明：

- **`seq` 不是装饰。** 今天的合并是 `[...stored, ...incoming]` 灌进 `Map` 再按 `stamp` 降序稳定排序
  （[stats.js:86-96](../server/stats.js#L86-L96)），所以 `t` 相同的记录保持"先库内、后新来"的顺序。
  SQL 的 `ORDER BY t DESC` 没有这个保证；`t DESC, seq` 复现它。少了这一列，"上限截断时先掉哪条"会和今天不同,
  变成不可复现的差异。不要用 `rowid` 顶替：`VACUUM` 会重排它。
- **没有 `bytes` / `compact` 列。** 两者都能从 `json` 现算（`Buffer.byteLength`、`rec.compact === true`），
  而一个账号的镜像最多二十几行，算一遍比维护一份"可能过期的派生列"便宜。
- **`stats_v` 放 `accounts` 而不是单独一张表。** 1:1，没有独立生命周期的数据不该多一张表。
- **`hash_scheme`。** 今天代价参数写死在 `SCRYPT_OPTS`。留一列以后能在不影响老账号的情况下换参数
  （登录时读该行的 scheme 校验，成功后可顺手升级）。
- **CHECK 只是兜底。** 真正的校验仍在 `shared/protocol.js`；不要把这些约束当成第二套规则来源。

## 4. 字段映射

| 今天的 `accounts.json` | B 之后 |
|---|---|
| `{alice: …}` 的 key | `accounts.user_key`（小写） |
| `rec.name` | `accounts.name` |
| `rec.salt` / `rec.hash` | 同名列 + `hash_scheme` |
| `rec.token` | `accounts.token`（UNIQUE） |
| `rec.loadout: null \| {} \| {chessId: {skill, module}}` | `loadout_saved` + `loadout_entries` 行 |
| `rec.ops: null \| {} \| {charId: {potential, cultivate}}` | 同上（`loadout_saved` 是共用的）+ `loadout_ops` 行 |
| `rec.stats: {v, records[]}` | `stats_v` + `stats_records` 行 |
| `rec.statsClearedAt` | `accounts.stats_cleared_at` |
| `rec.createdAt` / `rec.lastLoginAt` | `created_at` / `last_login_at` |
| 本版本不认识的字段 | `extra_json`（读出时合并回返回对象，写入时保持不动） |

`loadout_saved` 的用途见 §5 第 10 条：**今天 `null` 与 `{}` 是两个不同的状态**，
(`saveLoadout` 拒绝"账号本来为空 + 客户端推空")，而"表里没有行"这一个事实无法区分它们。

## 5. 读写路径

所有方法签名与返回形状不变（`lobby.js` 的 6 处调用点、`net.js` 的同步查找都按原样工作）。

### `load()` → `open()`

```
幂等：已经打开就直接返回
mkdir(dir) → new DatabaseSync(path.join(dir, 'accounts.db'))
  → exec(§3 的 PRAGMA)
  → BEGIN IMMEDIATE
      exec(CREATE TABLE IF NOT EXISTS …)
      if user_version === 0 && accounts.json 存在 && accounts 表为空:
          importJson(...)                     // 全部写入，一个事务
          rename accounts.json → accounts.json.imported
      PRAGMA user_version = 1
    COMMIT
```

`open()` 仍返回 Promise 并保持幂等，`server/http/websocket.js` 的 `await accounts.load()` 与
"读不出来就禁用账号但服务器照常启动"的既有行为都不变。
**唯一的差别（是改进）**：今天 `accounts.json` 解析失败会"当成空库继续跑"，下一次注册就把老数据彻底覆盖掉；
库文件损坏时 SQLite 会直接报错，因此走的是既有的 catch → 禁用账号 → 报错，**不会静默清空**。

### `register(username, password)`

```
校验 USERNAME_RE / 密码长度（不变）
salt/hash（scrypt，不变）
token = randomBytes(32).hex（不变）
BEGIN IMMEDIATE
  INSERT INTO accounts (...) VALUES (...) ON CONFLICT(user_key) DO NOTHING
  if changes === 0: COMMIT → { error: 'TAKEN' }        // 不再靠"先查再插"的竞态窗口
  INSERT loadout/stats 什么都没有（loadout_saved = 0, stats_v = NULL）
COMMIT
返回 { ok, key, username, token, loadout: null, ops: null, stats: null, statsClearedAt: null }   // 与今天一致
```

`TAKEN` 用 `ON CONFLICT DO NOTHING` + `changes` 判定，不去解析 SQLite 的错误文本（它是随版本变的字符串）。

### `login(username, password)`

```
SELECT * FROM accounts WHERE user_key = ?      → 没有 → NOT_FOUND
scrypt 校验（timingSafeEqual，不变）            → 不符 → BAD_PASSWORD
BEGIN IMMEDIATE
  UPDATE accounts SET last_login_at = ? WHERE user_key = ?
  token 为空 → 生成一个并 UPDATE（一个账号一个 bearer，绝不轮换：座椅靠它复原）
  读 loadout/ops/stats 的行
COMMIT
返回 { ok, key, username: rec.name, token, loadout, ops, stats, statsClearedAt }
```

注意 `username` 返回的是**注册时的拼写**（登录大小写不敏感），这一点不能丢。

### `lookupToken(token)`（同步，`hello` 用）

```
SELECT user_key, name, stats_v, stats_cleared_at FROM accounts WHERE token = ?
  → 无 → null
再查 loadout_entries / loadout_ops / stats_records（≤ 二十几行）
拼成今天的返回形状
```

`DatabaseSync` 是同步 API，所以 `net.js` 在铸会话之前那次同步调用
（[lobby.js `sessionForAccount`](../server/lobby.js#L775)）不需要任何改动，也不需要"内存热表"这种会过期的缓存。
每条 `hello` 多 4 次带索引的查询，微秒级；`statsPull` 同理。

> 可选微优化（不进第一批）：`sessionForAccount` 只要 key，可以让它走一条只查 `token → user_key` 的轻路径。
> 一行改动，等有实测需求再说。

### `saveLoadout(token, entries, ops)`

```
解析 token → user_key（一次索引查询）
if loadout_saved = 0 && 两个 map 都空 → 直接返回      // 保留今天的「不要用空覆盖空」
BEGIN IMMEDIATE
  DELETE FROM loadout_entries WHERE user_key = ?     // 整组替换：一次编辑最多 210 项，diff 不值得
  DELETE FROM loadout_ops     WHERE user_key = ?
  INSERT ...（逐项，预处理语句复用）
  UPDATE accounts SET loadout_saved = 1
COMMIT
```

整组替换而不是逐项 diff：调配是"玩家点开面板改一次"的低频操作，210 行以内的删除+插入在一个事务里是常数级成本；
逐项 diff 只会换来更多分支和更难读的测试。

### `saveStats(token, payload)`

这是 B 唯一"算法要小心"的地方。**合并仍然由 [mergeStatsPayload](../server/stats.js#L86) 负责**，
不在 SQL 里重写并集——理由同 §2：那条规则（并集、完整赢压缩、按 t 排序、16 KB / 1000 条上限）
已经在 `server/stats.js` 里被 3 个测试文件盯着，抄进 SQL 就是两份会各自漂移的实现。

```
incoming = normalizeStatsPayload(payload)              // 不变
BEGIN IMMEDIATE
  rows   = SELECT record_id, t, seq, json FROM stats_records WHERE user_key = ?（按 t DESC, seq）
  stored = { v: STATS_VERSION, records: rows.map(JSON.parse) }
  clearedAt = accounts.stats_cleared_at
  kept   = incoming.records 过滤掉 t <= clearedAt      // 清空必须跨设备生效（今天的行为）
  next   = mergeStatsPayload(stored, { v: incoming.v, records: kept })   // 纯 JS，语义逐字节一致
  diff(next.records vs rows):
    新 id        → INSERT（seq = 该账号当前 max(seq) + 1）
    同 id 且变了 → UPDATE json（compact → 完整记录的情况）
    落出上限的   → DELETE
COMMIT
返回 next（与今天 saveStats 的返回值一致）
```

代价：一次 push 读二十几行、写几条。今天是序列化**全部账号**再重写整个文件
（每个 push 一次 O(账号数 × 16 KB)），差别就在这里。**注意成本模型已经修正**：
客户端只在本地历史变化后 2 秒防抖推送、并按摘要去重（[statsSync.js](../public/js/ui/statsSync.js)），
不是定时推送，所以这不是一个正在发烫的热点，而是"账号一多就会变宽"的架构债。

### `clearStats(token)` / `readStats(token)`

```
clearStats: DELETE FROM stats_records WHERE user_key = ?; UPDATE accounts SET stats_v = NULL, stats_cleared_at = now
readStats : SELECT rows → { stats: { v, records } | null, clearedAt }
```

### `close()`

新增。`server/index.js` 的 `close()` 里加一行（[index.js:201](../server/index.js#L201)），
`http/boot.js` 的 SIGINT/SIGTERM 路径因此也覆盖。为什么必须有：Windows 上**打开的文件句柄会让
`fs.rmSync(tmp, {recursive:true})` 失败**，而三个账号测试的 `after()` 正是这么清理临时目录的。
今天没有句柄，所以这个坑现在不存在；换 SQLite 以后它是必踩的。同时实现 `[Symbol.dispose]`。

## 6. 不变量对照表

改造必须逐条保持。这张表就是验收清单：

| # | 今天的行为（证据） | B 之后 |
|---|---|---|
| 1 | 写是原子的（temp + rename）；崩溃不会写坏库 | 单事务提交；WAL 保证不会损坏 |
| 2 | 每次写都全量重写文件 | 只写变化的行（`saveStats`）/ 一个账号的调配行（`saveLoadout`） |
| 3 | 全部账号常驻内存 `Map` | 库是唯一真相；内存里不留副本（不引入新的失效面） |
| 4 | `load()` 幂等、启动预热 | `open()` 幂等（+ 迁移与导入，见 §7） |
| 5 | `lookupToken` 同步 | 同步（`DatabaseSync`），调用点不变 |
| 6 | 未知 token 惰性放行（`test/accounts.test.js` 固定的契约） | 完全不变：查不到就是 null，服务端不拒绝入场 |
| 7 | 一个账号一个 bearer，登录返回同一个 token | `UPDATE … WHERE token IS NULL` 才发新 token |
| 8 | 用户名占用 → `ALREADY` | `ON CONFLICT DO NOTHING` + `changes === 0` |
| 9 | key 小写、`name` 保留拼写 | `user_key` / `name` 两列 |
| 10 | `saveLoadout` 拒绝"账号本来为空 + 推空" | `loadout_saved = 0` 时同样直接返回 |
| 11 | 并集 + 完整赢压缩 + 16 KB/1000 条上限 + 按 t 排序 | 复用 `mergeStatsPayload`；`seq` 复现平手顺序 |
| 12 | `statsClearedAt` 挡回被清空的记录 | 合并前过滤 `t <= clearedAt`，语义不变 |
| 13 | 未知字段透传（老版本不毁新版本的数据） | `extra_json` |
| 14 | 落盘失败只记日志，不断 socket | 事务 catch → `log.error`，返回值按"尽力而为"处理 |
| 15 | token 写回文件（`_persist` 里查表补 token） | `accounts.token` 列，无需补写 |

## 7. 迁移、回滚与运维

**首次启动**（一次性、免手工）：

1. 建表；若 `user_version === 0` 且同一目录有 `accounts.json` 且表为空 → 一个事务导入全部账号
   （含 token、调配项、统计记录；每条记录按 `t` 重新分配 `seq`）。
2. 成功后把文件改名 `accounts.json.imported`（**保留，不删**）。
3. 导入失败（半途异常）→ 事务回滚 → 退出码非 0 并说明原因，不会留下一个"导了一半"的库。

**回滚到 A/旧版本**：`node tools/accounts-export.mjs --out accounts.json`（把库导出成今天的 JSON 形状），
停服、换成旧版本、启动。这条路径必须真的跑通一次，否则 B 就没有退路。

**备份**：

- `sqlite3 accounts.db ".backup 'accounts-backup.db'"`（在线、原子；`node:sqlite` 的 `backup()` 也可以脚本化）。
- 或 `VACUUM INTO 'accounts-backup.db'`（更小，但不含 WAL 里未合并的部分——`.backup` 更稳）。
- **不要**在运行中直接拷 `accounts.db`：`-wal` / `-shm` 才是最新数据，只拷主文件会丢最近的写入。
- 停服后直接拷三个文件是安全的。

**部署**：`ACCOUNTS_DIR` 的语义完全不变（还是"一个目录"，Docker 还是挂卷），只是内容从 `accounts.json`
变成 `accounts.db`（+ `-wal` / `-shm`）。**新增一条运维限制**：`ACCOUNTS_DIR` 不要放在 NFS/SMB 等网络盘上，
WAL 依赖的共享内存与锁在这些文件系统上不可靠（今天单文件原子的写法没这个限制）。

## 8. 测试计划

**影子等价测试（最关键的一个）**：不删旧实现，把它留在测试里当参照物——
`test/accounts-sqlite.test.js` 用随机生成的账号 / 调配 / 统计载荷，同时喂给
"今天的 JSON 实现"和"新的 SQL 实现"，断言两边 `deepEqual`。
合并语义、上限截断、平手顺序、`null` vs `{}` 全在这一个测试里被钉住，而且**不需要人工枚举**。

**必须改的 3 处**（其余 24 个用例不动）：

| 文件 | 位置 | 改法 |
|---|---|---|
| [accounts.test.js](../test/accounts.test.js#L248) | `the store survives a reload of accounts.json` | 改成关库重开（语义不变：重启后数据还在） |
| [accounts-stats.test.js](../test/accounts-stats.test.js#L127) | 轮询 `accounts.json` 文件 | 改成用第二个 `AccountStore` 轮询 `resolveToken` |
| [accounts-roundtrip.test.js](../test/accounts-roundtrip.test.js#L91) | `store.accounts.get('roundtrip')` 摸内部 `Map` | 改成轮询 `resolveToken`（不加测试专用 API） |

**新增**：schema 断言（表/索引/PRAGMA/`user_version`）；两个连接同开（WAL 可见性）；
`accounts.json` 导入（含 token 保留、调配/统计落地、文件被改名）；`export → import` 往返；
`close()` 后临时目录可删（Windows 也要过）；损坏的库不静默清空。

**每个新建 `AccountStore` 的测试都要 `close()`**（`afterEach` 或 `try/finally`），否则 Windows CI 上
临时目录清理会失败。这是本次改造最容易被忽略的"连锁改动"。

## 9. 待决事项

1. **B+：派生索引列。** 要不要在 `stats_records` 上加 `mode_id / difficulty / victory / rounds_passed / self_id`
   这类**可空、可从 json 重建**的列？加了就能"按难度/胜负查某人战绩"并做真正的聚合（未来的统计总览、排行榜），
   代价是多一条"这些列永远不是真相来源"的纪律，以及一个 `accounts:reindex` 命令。
   我的建议：**第一批不做**，等真有查询需求再加（加列是纯加法，不需要重写存储）。
2. **调配要不要拆行。** 拆（§3）比留一个 JSON 列多约半天，换来的是约束与可查询性；
   如果你只想解决统计那边的全量重写，调配可以暂留 JSON 列。我的建议：一起拆，因为那两份 map 的模式
   是服务端自己的，拆了不会跟着客户端漂移。
3. **Node 底线。** `node:sqlite` 从 **22.13** 起免 `--experimental-sqlite`（可移植包钉的 v22.23.3、CI 的 22/24、
   Docker 的 `node:22-alpine` 都满足）。要顺手把 `engines` 提到 `>=22.13`，并接受启动时一行
   `ExperimentalWarning`（可用 `--disable-warning=ExperimentalWarning` 消掉）。

## 10. 工作量与拆分

| PR | 内容 | 估计 |
|---|---|---|
| 1 | schema + `open/close/migrate` + `accounts` 表 + register/login/lookup + `accounts.json` 导入 | 1 天 |
| 2 | `loadout_entries` / `loadout_ops` + `loadout_saved` 语义 | 0.5 天 |
| 3 | `stats_records` + 行级 diff + 影子等价测试 | 1 天 |
| 4 | `tools/accounts-import.mjs` / `accounts-export.mjs` + 文档（README、DEPLOY、FORK_NOTES、design/network.md §8.1、design/client.md、CHANGELOG、history） | 1 天 |

合计 **3.5–4.5 个工作日**，比 A（纯替换，约 1 天）多 2.5–3.5 天。
每个 PR 单独可合、可回滚；PR 1–3 期间行为必须与今天逐字节等价（影子测试守着）。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 合并语义漂移（上限、平手顺序、compact 规则） | 影子等价测试；合并逻辑仍只有一份（`server/stats.js`） |
| `node:sqlite` 是实验 API，22/24 之间细节有差异（`timeout` 选项 22.16+、`iterate` 22.13+、`setReturnArrays` 22.16+） | 只用 22.5 就存在的最小面（`prepare/get/all/run/exec`）；等锁用 `PRAGMA busy_timeout` 而非构造选项 |
| Windows 文件句柄让测试清理失败 | 所有 store 都 `close()`；`close()` 接进 `server/index.js` 的 `close()` |
| 备份故事变复杂（`-wal`/`-shm`、网络盘） | 文档写清 `.backup` 与"停服再拷"；`ACCOUNTS_DIR` 禁网络盘 |
| 半途迁移留下不一致状态 | 建表+导入+`user_version` 在同一个事务里；失败即回滚并退出 |
| 一次改动面太大 | 按 §10 拆 4 个 PR，1–3 保持行为等价，影子测试守着 |

## 12. 为什么可能是 A 更好

诚实地说：如果真实需求只是"账号别丢、备份别麻烦、别被手改坏"，**A 就够了**，而且只花 1/4 的成本。
B 值得做的条件是下列**至少一条**成立：

- 账号数会到几百以上（每个 push 的写放大开始变得可见）；
- 想要按账号/难度/胜负聚合统计（需要 B+ 的派生列）；
- 想要 DB 级的约束与索引（而不是"代码自觉"）；
- 愿意为"未来能把统计做成一等公民"先付这 3 天的架构税。

如果这些都不成立，本文就是一份**归档的备选方案**，不必实施。
