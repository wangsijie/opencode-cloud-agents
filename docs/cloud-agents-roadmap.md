# Cloud Agents 路线图

目标：把 opencode-cloud 从"实例管理器 + stock OpenCode UI"演进为类似 Cursor Cloud Agents 的产品形态——

> 在对话框里选好 repo 和模型，输入一段 prompt，直接开一个 session。每个 session 对应一个
> sandbox，进去后自动 clone 或更新 repo，然后开始干活。干完一段时间后休眠，休眠期间仍能
> 点进来看完整对话历史；此时输入新内容，sandbox 自动无感恢复并继续。

本文档是分里程碑的实施计划。每个里程碑独立可交付、可验收，完成后即可日常使用其成果。

## 一、现状盘点

### 已经具备的（且是最难的部分）

| 能力 | 现状 |
|------|------|
| 每实例独立容器、独立休眠 | ✅ 一个逻辑实例 = 一个 Sandbox DO = 一个容器（[instances.ts](../src/instances.ts)） |
| 语义化空闲判定 | ✅ `LifecycleCoordinator` 按 OpenCode 执行状态（而非网络流量）判定空闲，10 分钟后 quiesce → checkpoint → stop；浏览器 tab/SSE/WebSocket 不算活跃（[lifecycle.ts](../src/lifecycle.ts)） |
| 工作区持久化 | ✅ `/workspace` 完整快照到 R2，含 OpenCode 会话数据（`XDG_DATA_HOME=/workspace/.opencode-state`），唤醒时自动恢复；备份台账保证可重试清理 |
| 防陈旧访问 | ✅ runtime epoch 机制，休眠后旧 tab 收 410，被动流量永远无法拉起容器 |
| 认证 | ⚠️ Cloudflare Access 已移除，改为写死在 [access.ts](../src/access.ts) 的单一 admin 密码 + HttpOnly cookie，`/api/*` 全部关闭；临时方案，无限流 |
| stock UI 单域名代理 | ✅ `/ui/<id>/<epoch>/...` + `/gateway/<id>/<epoch>/...` + bootstrap 补丁（**M6 已整体退役**，见下） |
| 模型目录 | ✅ [opencode-config.ts](../src/opencode-config.ts) 集中定义 provider/model/能力/成本 |
| 仓库凭据 | ✅ 镜像内置 SSH key（可 push、可签名）、`gh`、Wrangler 凭据 |
| SDK 驱动会话 | ✅ `runSdkTest` 已验证从 Worker 侧 `session.create` + `session.prompt`（[index.ts](../src/index.ts)） |

结论：**休眠/唤醒/持久化这一层基础设施已经完成并且相当健壮**，目标形态缺的主要是"会话为中心的产品层"。

### 与目标的差距

1. **工作单元错位**：现在创建的是"实例"，不带 repo（模板镜像固化）、不带模型、不带 prompt；创建后必须人工进 stock UI 才开始干活。
2. **repo 在构建期固化**：`logto-v1` 在 Docker build 时 clone，换仓库要加镜像 + DO class + migration，无法"对话框里任选 repo"。
3. **没有自定义会话视图**：Hub 只有实例管理表格；看对话内容必须唤醒容器进 stock UI。
4. **休眠后历史不可读**：对话数据只存在 `/workspace` 快照（R2 里的 tar）内，不唤醒就看不到。
5. **休眠后不能续聊**：当前设计*有意*让一切被动请求收 410、只有显式 `POST .../wake` 能拉起容器。缺一条"用户发新消息 = 显式唤醒意图"的通道。
6. **模型选择入口缺失**：只能进 stock UI 后切换。

## 二、目标架构概览

```
浏览器（自建 SPA，Worker 静态资源托管）
   │  只走 /api/sessions*（列表/创建/消息/事件），不直连容器 gateway
   ▼
Worker（路由 + Access 认证）
   │
   ├─ Hub DO ──────────────── 会话注册表（SessionRecord：repo、model、opencodeSessionId、状态）
   ├─ SessionAgent DO（每会话）─ 开工/投递状态机：wake → ensure-repo → promptAsync；
   │                            消息排队、transcript 镜像写入
   ├─ LifecycleCoordinator DO ─ 现有语义生命周期（不变）
   ├─ Sandbox DO + 容器 ─────── OpenCode server + /workspace（现有，去模板化）
   └─ R2 ─────────────────────  workspace 快照（现有） + transcripts/ 镜像（新增）
```

核心不变式延续现有设计：

- 容器仍然只能被**显式意图**唤醒；新增的唤醒入口只有两个——创建会话、向会话发消息。
- SSE 重连、页面刷新、列表轮询依旧永远不唤醒容器。
- 休眠期间的一切读取（历史、摘要、diff 快照）都来自容器外的镜像数据。

## 三、关键设计决策

### D1 · 用 `session.promptAsync` 派发任务（✅ 已冒烟验证）

SDK v2 已提供 `session.promptAsync`（提交后立即返回，agent loop 在容器内 server 侧运行）。
因此 Worker/DO 不需要为一次几十分钟的任务持有长连接；现有活动探测会把运行中的会话判为
busy 并自动保活，干完自然进入 10 分钟空闲倒计时。

**Spike 结论（2026-07-25，OpenCode 1.18.4 本地实测）**：

- `POST /session/{id}/prompt_async` 返回 `204`，耗时约 46ms；客户端断开后任务照常在
  server 侧完整执行（`sleep 90` 任务 95 秒后正常完成）。
- 运行期间实例视图 `lifecycle: busy`、`activeSessionCount: 1`，busy 信号来自 legacy
  `/session/status`（该会话运行在 legacy 引擎；v2 `/api/session/active` 为空）。现有
  保活/空闲机制零改动可用。
- **busy 期间再次 `prompt_async` 同样 204 立即返回，消息进入服务端队列串行执行**：前一任务
  一完成，排队消息立刻开始处理。M5 的消息投递因此无需自建顺序队列，只需保证"唤醒后投递"。
  **M5 修正**：这条结论的前提是「会话已经 busy」——本次 spike 恰好是在 busy 期间补发的。
  打到 **idle** 会话上的并发 prompt 不排队而是互相竞争，M5 实测出现乱序，见该里程碑记录。
- 任务完成后实例准时进入 10 分钟 idle 倒计时。
- 附带发现：网关会透传上游 `Content-Encoding: gzip`；Worker 内 fetch 自动解压不受影响，
  但脚本/镜像消费方需注意。

### D2 · Transcript 镜像：休眠可读的唯一数据源

- 醒着时：会话页直接经 gateway 代理 OpenCode 实时 API（messages + SSE）。
- 睡着时：读 R2 `transcripts/<sessionId>/` 下的镜像 JSON（消息正文）+ Hub/SessionAgent DO
  里的轻量摘要（标题、最后活动、状态），列表页只用摘要。
- 镜像写入时机（按里程碑递进）：M4 在 quiesce 之后、checkpoint 之前导出一次（此时 server
  仍在运行，直接调 `session.messages` 拿全量）；醒着时借活动探测节拍周期刷新，控制 crash
  丢失窗口；M6 升级为事件流实时镜像。
- 大小策略：消息正文放 R2（DO 单值 128KB 放不下长对话），DO 只存索引/摘要。

### D3 · 每会话一个 SessionAgent DO，负责排队与投递

复用 LifecycleCoordinator 的 operation + alarm 模式，但业务职责分开、不混进 runtime 生命周期：

- 开工序列：`wake()`（走现有 coordinator）→ ensure-repo → `session.create(directory)`（首次）
  → `promptAsync(model, parts)` → 更新会话状态。每步失败都持久化、alarm 重试、状态对 UI 可见。
- 消息队列：对睡着的会话 `POST messages` 立即 202，pending prompt 持久化，alarm 驱动
  唤醒后投递；消息带 id 幂等去重。
- 这与"显式唤醒"原则一致：发消息是显式意图，其余被动流量行为不变。

### D4 · repo 运行时置备，单一通用镜像

- 仓库目录表（M1 先静态配置在 `src/repos.ts`，M6 可换 GitHub API 动态列表）：
  `{ repoKey, sshUrl, defaultBranch, setupCommand? }`。
- `ensure-repo` 挂在唤醒流程 restore 之后：`/workspace/<repoKey>` 不存在 → 浅 clone；
  存在（来自快照恢复）→ `git fetch origin`。**只 fetch 不动工作区**——是否合并/rebase 由
  agent 或用户决定，避免破坏未提交工作。clone 只发生在快照缺失时，后续唤醒都是快照恢复。
- **分支策略（已确认）**：不自动建分支，agent 在默认分支上直接工作；产出管理（是否建
  分支、commit/push/PR 流程）作为整体课题放 M6 设计。
- OpenCode session 的 `directory` 指向 `/workspace/<repoKey>`（活动探测的 known-locations
  机制已支持多目录）。
- 由此 `LogtoSandbox` 类和模板镜像机制走向退役（已于 2026-07-26 清理，见下）。

### D5 · 无感恢复的体验定义

"无感"= 用户视角不换页面、不点唤醒：输入 → 乐观渲染 + "正在唤醒沙箱"状态条 →（冷启动
约数十秒：容器拉起 + R2 恢复 + server 启动）→ 自动切到实时流。技术上是 D3 的排队投递 +
前端状态机，不是把冷启动变成零秒。冷启动时长本身的优化（快照增量化等）放 M6 按需做。

### D6 · Web UI：自建 SPA，stock UI 只做过渡期逃生舱

stock OpenCode web 无法承载目标形态：它是"单 server → 多 project → 多 session"的 IDE
客户端，与"多容器聚合、每容器恰好一个 session"是转置关系；它的数据层直连活着的 server，
做不了休眠历史与排队续聊；且驯服它的代理机制（bootstrap localStorage 虚拟化、入口 bundle
正则补丁、路径作用域资产图）版本锁死、升级易碎。因此：

- **主 UI 自建**：`web/` 目录 Vite + React + TS SPA（已确认；opencode share 页的 part
  渲染逻辑仍可作为参考实现阅读），构建产物走 Wrangler 静态资源托管，与 Worker 同域同
  部署，`pnpm run deploy` 一条链不变。核心组件是 message part 渲染器，其余是列表与表单。
- **API 边界**：UI 永远只与 `/api/sessions*` 通信，不直连容器 gateway；醒（实时代理）/
  睡（镜像）对 UI 透明。project 概念在 UI 中消失——directory 由 SessionRecord 钉死。
- **一容器一会话靠产品层收敛**：hub 不提供开第二个 session 的入口，不做服务端硬禁；
  逃生舱里开出的额外 session 由现有活动探测照常保活，镜像与列表只聚焦主会话。
- **stock UI 退役路径**：过渡期保留每会话"打开完整 IDE"链接（terminal/文件浏览/diff 先
  白嫖现成的）；自建 UI 覆盖 diff 与终端后（M6）整体退役，连带删除 `/ui/` 资产代理、
  bootstrap、bundle 补丁，并把 `/gateway/` 从公网路由收敛为 Worker 内部通信。
  **已于 2026-07-26 执行完毕**：四条路由与整个 `stock-ui.ts` 删除，公网只剩 `/api/*` 与
  SPA 外壳，进容器只能走 Worker 内部 DO RPC。

### 决策记录（2026-07-25 已拍板）

| 问题 | 决定 |
|------|------|
| 开工顺序 | 最先执行 promptAsync spike（约半天），验证 D1 后再按 M1 起推进 |
| 前端栈 | React + Vite + TS（评估过 Solid 借鉴 opencode share 页，按日常栈定 React） |
| repo 列表来源 | 静态 `src/repos.ts` 起步，动态化留给 M6（已在 M6 落地：`GITHUB_TOKEN` 存在时走 GitHub API） |
| 分支策略 | ~~不自动建分支，默认分支直接干~~；M6 定案：永不提交默认分支，发布落在 `opencode/<session-id>` |
| 空闲休眠时长 | 维持 10 分钟；M5 上线后再评估是否缩短 |
| 移动端 | 手机是一等场景，M3 起移动优先布局 |
| 多用户 | 单用户模型，不预留 owner 字段 |

## 四、里程碑

> 开工顺序：最先做 M2 里的 promptAsync spike（见决策记录），然后 M1 → M2 → M3 → M4 → M5。
> M1–M5 已全部完成（2026-07-26），目标形态闭环。M6 选做池八项亦已全部完成（2026-07-26）：
> 实时事件镜像、代码产出闭环、动态仓库列表、会话管理、终端/文件浏览、退役 stock UI、
> 冷启动测量与优化、清理。stock UI 下线后，公网不再有通往容器的路由。

### M1 · 运行时 repo 置备（去模板化） — ✅ 完成（2026-07-25）

实际交付与验证：`src/repos.ts` 目录表（logto 起步）；`ensureRepoProvisioned` 挂进
`performWakeForLifecycle`（restore 之后、server 启动之前；clone 失败阻断唤醒，fetch 失败仅告警）；
创建 API/对话框改为工作区选择（空白 / 目录表仓库），仓库实例强制 base 镜像；旧 logto-v1
实例不受影响。本地实测：logto 首次唤醒 14s 内完成 clone；完整 clone→checkpoint→restore→fetch
闭环用小仓库验证通过（本地 localBucket 模式恢复大工作区受 413 限制，见风险表；生产不受影响）。

原范围：

- 新增 `src/repos.ts` 仓库目录表；`InstanceRecord` 增加 `repoKey`（模板字段保留用于旧实例）。
- 容器侧 `ensure-repo` 步骤接入 `wakeForLifecycle`（restore 之后、标记 running 之前）：
  缺失则 `git clone --depth 1`，存在则 `git fetch`；失败进入现有错误上报路径。
- 创建 API/对话框：repo 下拉替换模板选择；新建实例一律用 base 镜像。
- 迁移：存量 `logto-v1` 实例照常工作，不强迁。

验收：

- 新建任选 repo 的实例，首次唤醒后 `/workspace/<repoKey>` 就位并可在 stock UI 里干活。
- stop 后再次唤醒：目录来自快照恢复，且 fetch 拿到了远端新提交。
- `pnpm test && pnpm run typecheck` 通过；README 模板章节更新。

### M2 · 会话化创建：repo + 模型 + prompt 直接开工 — ✅ 完成（2026-07-26）

实际交付与验证：`src/sessions.ts` 会话类型 + Hub DO 会话注册表（`session:<id>`，与实例同 id）；
新增 `SessionAgent` DO（migration v5）执行 wake → ensure-repo（沿用 M1 唤醒流水线）→
`session.create(directory=/workspace/<repoKey>)` → `promptAsync`，失败自动退避重试 3 次
（5s/20s/60s）后停在 `failed` 并可手动重试；`src/opencode-config.ts` 派生模型目录
（`MODEL_OPTIONS`/`parseModelRef`，模型 id 含斜杠，只取首段为 provider）；
`src/instance-runtime.ts` 抽出 Worker 与 DO 共用的唤醒/生命周期解析；API
`GET|POST /api/sessions`、`GET|DELETE /api/sessions/:id`、`POST /api/sessions/:id/retry`、
`GET /api/catalog`；Hub 首页加 composer 与会话卡片列表（阶段徽章、错误、重试、删除、
“打开完整 IDE”）。

本地实测（wrangler dev + 真实容器）：

- composer 提交后全程不进任何 UI，容器自行 clone logto、建 OpenCode 会话、执行 prompt；
  transcript 里 agent 用 `read` 工具读到真实 checkout 并正确作答，随后按现有机制转 idle。
- 阶段流转 `queued → starting → working`，实例 runtime 依次 `waking → busy → idle`。
- 故意配置无效 clone URL：三次退避重试后停在 `failed`，`lastError` 带 git 原文；
  `POST .../retry` 重新进入派发。
- `DELETE /api/sessions/:id` 连带删除实例与快照，会话与实例列表都清空。

偏差与备注：

- 不下发自定义 `messageID`。OpenCode 的消息 id 内含可排序时间戳前缀，塞随机 UUID 会破坏
  消息顺序；M5 的幂等去重改用 SessionAgent 队列内的 prompt id（派发成功后才出队）。
- 派发时取一次 90 秒 work lease，桥接"任务被接收"到"探针看得见 busy"之间的空窗。批次交付
  完成后确认会话确实活跃（`awaitPromptSettled`）再 `endWork`：确认这一步是安全前提，因为
  `endWork` 会立刻重探，而任务尚未起跑时的那一探会读成 idle。确认不到就让租约自然过期——
  观测不到的会话保守地当作在执行。（早先的做法是一律不 endWork、只等过期，代价是任何短于
  90 秒的任务结束后仍会显示满 90 秒的"执行中"。）
- 会话删除由 Worker 先调 `SessionAgent.markDeleted()` 再调 `Hub.beginDelete()`，避免
  Hub↔SessionAgent 互相等待造成 DO RPC 死锁（SessionAgent 会回写 Hub）。

原范围：

- promptAsync 冒烟 spike（见 D1；按决策记录已前置到 M1 之前执行），结论写进本文档。
- `SessionRecord`（Hub DO）：`{ id, repoKey, model, title, opencodeSessionId?, phase, createdAt, … }`
  与实例 1:1（session id 即 instance id，或显式互指）。
- 新增 `SessionAgent` DO（wrangler migration v5）+ 开工序列（见 D3）。
- API：`POST /api/sessions {repoKey, model, prompt}` → 202；`GET /api/sessions` 列表含
  开工阶段/失败原因。
- Hub 首页加"新会话"composer：repo 下拉 + 模型下拉（来自 `OPENCODE_CONFIG`）+ prompt 输入。
- 观察入口暂用现有 stock UI（点进去能看到会话在跑）。

验收：

- composer 提交后**不进任何 UI**，容器自行 clone/恢复并开始执行 prompt。
- 干完后 10 分钟自动休眠（现有能力，无需新代码）。
- 开工序列任一步失败（如 repo 拉取失败）在列表页可见且可重试。

### M2.5 · 去兼容化清理 — ✅ 完成（2026-07-26）

M2 落地后确认「还在测试阶段、不需要向后兼容」，把过渡期的兼容层一次性清掉，Hub 只剩会话：

- **模板镜像退役**：删掉 Dockerfile 的 `logto` stage 与 `WORKSPACE_TEMPLATE` 参数、
  `LogtoSandbox` 容器与 DO 绑定；migration `v6` 用 `deleted_classes` 连带销毁其 DO 存储。
- **`imageKey` 概念消失**：`InstanceRecord` / Sandbox identity / lifecycle state / 各 RPC
  入参全部去掉镜像键，`repoKey` 改为必填——实例只为跑会话而存在。
- **legacy 实例兼容删除**：Hub 构造函数不再注册 `opencode` → `original-opencode`
  （schema 版本 2 → 3），备份归属识别去掉 `opencode-manual` / `opencode-idle-stop` 特例。
- **adoption 路径删除**：`adoptRunningForLifecycle` 与 coordinator 的 `'adopt'` 操作类型
  一并移除；协调器初始化后一律是 `sleeping`，只有显式 `wake()` 能启动容器。
- **独立实例入口删除**：`POST /api/instances` 与创建对话框、首页「其他实例」区块下线。
  `/api/instances` 保留为运维读取面与单实例操作（wake/checkpoint/stop/test/delete），
  M4 验收「用 /api/instances 确认无唤醒」照常可用。

**部署顺序（重要）**：`v6` 会销毁 `LogtoSandbox` 的 DO 存储，而实例的 R2 快照句柄就存在那里。
必须先在 Hub 上把存量实例全部删除（删除流程才会清 R2），再部署本次变更，否则快照会变成
无法枚举的孤儿对象。

清理后本地复测：全新状态下不再自动出现 legacy 实例，`POST /api/instances` 返回 405，
会话创建 → clone → 执行 → 回答 → idle → 删除全链路正常。

**生产落地（2026-07-26）**：先在 Hub 上删光存量实例（连带清 R2 快照），再 `pnpm run deploy`；
部署后确认线上 Worker 绑定只剩 `Hub` / `LifecycleCoordinator` / `Sandbox` / `SessionAgent`
（`LogtoSandbox` 已随 v6 消失），并用 `wrangler containers delete` 清掉残留的
`opencode-cloud-logtosandbox` 容器应用。

### M3 · 自定义会话页（醒着时的聊天视图） — ✅ 完成（2026-07-26）

拆成 7 步执行，后端先行（S1–S3 每步都能单独用 curl 验完），SPA 脚手架可与之并行：

| 步骤 | 内容 | 状态 |
|------|------|------|
| S1 | `GET /api/sessions/:id/messages` 被动只读 + 会话徽章派生 | ✅ 2026-07-26 |
| S2 | `GET /api/sessions/:id/events` SSE 转发（按会话过滤容器事件流） | ✅ 2026-07-26 |
| S3 | `POST /api/sessions/:id/messages` 续聊 + `.../abort` | ✅ 2026-07-26 |
| S4 | `web/` Vite + React + TS 脚手架、Wrangler 静态资源托管接线 | ✅ 2026-07-26 |
| S5 | 列表页 + composer 迁入 SPA | ✅ 2026-07-26 |
| S6 | 会话详情页 + message part 渲染器 | ✅ 2026-07-26 |
| S7 | 并发 tab 验证、测试/类型、文档回填 | ✅ 2026-07-26 |

**S1 实际交付（2026-07-26）**：`src/sessions.ts` 加 `deriveSessionStatus`（把 dispatch phase 与
容器 runtime 两个状态机折成一个徽章：删除 > 派发失败 > runtime 错误 > 未完成的派发 >
runtime 实况）、`deriveLastActivityAt` 与 `SessionMessage`/`SessionTranscript` 类型；
`Sandbox.listOpencodeSessionMessages()` 经既有 epoch 门控 client 读消息，**不取 work lease
也不碰 idle deadline**；`resolveRunningRuntimeEpoch()` 只读生命周期（`ensureLifecycleInitialized`
建档一律从 `sleeping` 起，永不启容器），phase 非 `running_*` 即视为休眠；`SessionView` 补
`status` / `lastActivityAt`。transcript 四态 `pending`（OpenCode 会话还没建）/ `sleeping` /
`live` / `error`，响应头带 `X-OpenCode-Hub-Transcript-{State,Source,At}`；`source` 预留
`mirror` 给 M4，届时只需在 `sleeping` 分支前插入镜像读取。

本地实测（wrangler dev + 真实容器）：未建会话读到 `pending`；跑起来读到 `live` 与真实
消息（agent 读完 logto checkout 后的回答）；idle 后连读 4 次 `idleDeadlineAt` 纹丝不动；
force-stop 后连读 3 次全是 `sleeping` 且容器保持 `stopped` / `platformRunning: false`。

**S1 发现（影响 S6）**：实际 part 类型比下面列的多，出现了 `step-start` / `step-finish`，
渲染器应直接跳过而不是当未知类型显示占位；每个 part 自带稳定 `id`（`prt_…`），SSE 增量
与全量拉取的合流可直接按它做 map，不必自造 key。

**S2 实际交付（2026-07-26）**：`src/session-events.ts` 承载 SSE 转发。OpenCode 只有一条
服务器级事件流 `/event`，Worker 用 `TransformStream` 把上游 body 管过来，按
`properties.sessionID` 过滤后以自有协议重发：`event: hub` 是 Hub 自己的状态帧
（`live` / `sleeping` / `pending` / `ended` / `error`），`event: opencode` 是逐字转发的容器
事件。同 S1 的被动约束——不取 work lease、不唤醒容器；挂着的流也拦不住 idle-stop。
没有可接的目标时（休眠 / OpenCode 会话还没建）依然返回合法 SSE：报一帧状态就关。
**流会结束，且结束不是错误**——客户端是 `EventSource`，靠 `retry: 15000` 自己重连，重连
拿到的状态帧就是会话页发现「醒了 / 睡了」的机制。帧解析（跨 chunk 切分、多行 data、
sessionID 归属）拆成纯函数并单测，共 32 个用例。`OPENCODE_PORT` /
`RUNTIME_EPOCH_HEADER` 顺手从 sandbox.ts 与 stock-ui.ts 的重复定义收敛进
`instance-runtime.ts`。

本地实测（wrangler dev + 真实容器）：挂流期间发 prompt，转发到 15–22 帧
（`message.updated` / `message.part.updated` / `message.part.delta` / `session.status` /
`session.diff`，以 `session.idle` 收尾），每一帧的 sessionID 都是本会话；休眠会话读到
一帧 `sleeping` 且容器保持 `stopped`；idle 但醒着的会话挂流 90 秒不断不报错。
**跨会话隔离实测**：在同一容器里另开一个 OpenCode 会话并发 prompt，网关原始流收到它的
36 帧，本会话的 `/events` 转发 0 帧。

**S3 实际交付（2026-07-26）**：`POST /api/sessions/:id/messages` 续聊、`POST /api/sessions/:id/abort`
中断。续聊复用 SessionAgent 已有的持久队列（新增 `queuePrompt`），走的就是开场 prompt 那条
路径——逐条出队，因此连发按序投递；带 `model` 可换模型，新模型同时写回 SessionRecord，
列表与 composer 都能看到；发消息也顺带清掉 `lastError` 并重新入队，等于「发送即重试」。
abort 走新的 `Sandbox.abortOpencodeSession` RPC，**不取 work lease**——它是结束活动而不是
制造活动，取租约反而会推迟空闲窗口。

**M3 边界**：两条写路径都要求容器已经醒着，睡着返回 409。队列本身其实能顺手唤醒（派发时
就会 wake），但「发消息触发一次要等的唤醒」需要前端进度条，那是 M5。这个检查是产品决策
不是保证：检查与派发之间容器停掉的话，agent 照样会唤醒它，这个竞态无害，M5 之后它就是正路。
（**M5 已解除**：发消息这条路径的 409 已删除，abort 仍保留该检查。）

本地实测（wrangler dev + 真实容器）：多轮对话连续 7 条消息全部按序落地；中途从
gemini 切到 grok-4.5，transcript 里两条 assistant 消息的 `modelID` 确实不同；连发 3 条
→ 队列 `pending 3` 后按 1/2/3 顺序投递；睡着 / 未开工 / 空 prompt / 未知模型分别 409/409/400/400。

**S3 发现**：最初的幂等只查了队列里的 `pending`，**漏掉了已派发的**——而客户端重试恰恰
大多发生在派发之后，实测同一个 `promptId` 被投递了两次。已改为在 agent 状态里额外记一份
有界的 `deliveredPromptIds`（保留最近 50 条），队列与已投递都查；补测同一 promptId 在派发
后重发，transcript 里只出现一次。

**abort 补验（2026-07-26，供应商恢复后）**：让 agent 从 1 数到 5000，输出到一半时打断
——最终停在 **1367**，消息上带 `MessageAbortedError`。作为对照，自然写完的长文
`error` 是 `null`。中途还踩到一次假阳性：第一次用「写 2000 字散文」验，模型太快，在我
第一次轮询之前就写完了，`aborted` 虽然返回 true 但文章是自然收尾的——所以判定 abort
是否真的生效，要看消息上的 `MessageAbortedError`，不能只看端点返回值。顺带把
`abortOpencodeSession` 的返回从 `result.data !== false` 收紧成 `=== true`：OpenCode 这个
接口返回纯布尔，false 表示当时没有可打断的运行，含糊的取值不该被报成「已打断」。

**S4 实际交付（2026-07-26）**：`web/`（Vite 8 + React 19 + TS）+ 根 `vite.config.ts`；
`wrangler.jsonc` 加 `assets`，产物 `web/dist` 由同一个 Worker 同域托管。
`pnpm run deploy` 前置 `build:web`，一条链不变；`pnpm dev` 也前置构建（`web/dist` 不入库，
否则新克隆直接起不来）；`pnpm dev:web` 起 Vite 开发服务器并把 Worker 路由代理到
`wrangler dev`，前端调的是真 DO、真容器。`pnpm run typecheck` 现在同时检查 Worker 与 web
两个 tsconfig（web 侧是 DOM + JSX，与 Worker 侧的类型互不污染）。

**两个必须绕开的路由冲突**：

1. Vite 默认把产物放 `/assets/`，而这个前缀已经属于 stock UI 的全局资产代理。
   改用 `build.assetsDir: 'hub-assets'`。
2. 静态资源托管默认会抢在 Worker 前面应答，但这里三件事都要求 Worker 先跑：Access 必须
   把住门、`/` 要按 query 决定给 SPA 还是 stock UI、`/assets/` 要继续走容器代理。
   因此配 `run_worker_first: true`，路由决策全留在 Worker 里；SPA 外壳由 `serveAppShell`
   显式经 `env.ASSETS` 取 `index.html`，未命中路径仍然是 404 而不是被 SPA fallback 吞掉。

SPA 暂时挂在 `/app`，`/` 保持现有 Hub 不动——S5 才把列表与 composer 搬进去并翻转 `/`，
这样每一步都是可发布的。外壳本身会读 `/api/sessions` 与 `/api/catalog`，因为 S4 真正要
验的就是「同域 API + 构建 + 托管」这条链。CSS 按移动优先立了基线（安全区内边距、
720px 之后放宽），配色沿用 Worker 现有的休眠页，过渡期两边不像两个产品。

本地实测：`/app` 与 `/app/sessions/x` 都返回外壳、`hub-assets` 资源 200、
`/`｜`/api/*`｜`/hub/bootstrap.js`｜`/?_hub=…` 全部行为不变、`/nope` 仍是 404；
浏览器里 375px 与 1100px 两个宽度都正常渲染，控制台无报错，统计数字来自真实 API；
`pnpm dev:web` 的 5173 能正确代理到 8787。

**S5 实际交付（2026-07-26）**：SPA 接管 `/`，`src/hub-ui.ts`（491 行模板字符串）整体删除。
composer（仓库 / 模型 / prompt）与会话列表迁入 React；卡片显示一个状态徽章、最后活动时间、
自动休眠倒计时，以及打开完整 IDE / 重试开工 / 停止 / 删除。徽章直接用 S1 的服务端
`session.status`，不再像旧 UI 那样在客户端从 lifecycle+phase 拼——这正是 S1 那部分工作的意义。

路由收尾：`/hub-assets/*` 直接走 `env.ASSETS`；其余「浏览器会导航到的」GET 请求返回 SPA
外壳由前端解析路由；**非 HTML 请求仍然是 JSON 404**，所以敲错的 API 路径不会被回一个页面。
`/`+`_hub` 进 stock UI、`/assets/*` 走容器代理这两条都在 SPA 之前判定，行为不变。

本地实测（浏览器实操）：375px 下用 composer 真建了一个会话，卡片从「正在开工」跟到
「任务执行中」；停容器后徽章变「已休眠」且「停止」按钮自动消失；点删除后列表清空；
1100px 下 meta 变四列、composer 控件同排。

**S5 发现**：两个都在浏览器里才暴露。① flex 子项默认 `min-width: auto`，模型名较长时
select 不肯收缩，把整行顶出视口（375px 视口渲染成 405px 宽）——补 `min-width: 0`。
② 轮询原本只在 `!document.hidden` 时跑，从后台切回来最多要等一个周期才更新；补了
`visibilitychange` 立即刷新。顺带一提，自动化浏览器把页面恒定报成 hidden，所以轮询这条
必须手动把 `document.hidden` 打开才验得到——直接看截图会误以为轮询坏了。

**S6 实际交付（2026-07-26）**：会话详情页 `/sessions/:id`。路由自己写了 30 行
（两条路由不值得引依赖）；`useTranscript` 先全量拉 `/messages`，再挂 `/events` SSE 增量，
**按 part.id 做 map 合并**（S1 发现：流式文本是同一个 part 反复更新，不是不断新增）。
part 渲染器覆盖 text（markdown）/ reasoning（默认折叠）/ tool（单行摘要）/ todo，
`step-start`/`step-finish` 直接跳过（S1 发现），其余类型显示「未支持的内容类型：<type>」——
写出类型名而不是静默隐藏，因为那正是下一步该做什么的线索。消息上的 `error` 单独渲染，
所以中断与供应商报错在页面上看得见。列表卡片标题点进详情，修饰键点击仍走原生链接行为。

本地实测（浏览器实操）：列表点进详情，历史正确渲染（用户气泡 + `read package.json`
工具行 + markdown 正文）；在页面里发续聊，**纯靠 SSE** 4 秒内消息数 3→5，与服务端
`/messages` 逐字对比一致（尾部 `…38|39|40` 完全相同），全程没有刷新；停掉容器后详情页
显示「已休眠」横幅、输入框禁用、按钮变成「唤醒并打开 IDE」。

**S6 发现**：① markdown 会把单个换行折叠成空格，agent 数了 40 行结果渲染成 3 行——加
`remark-breaks` 保留软换行，因为 agent 的输出是按终端习惯写的。② 手机上 composer 一度占掉
半个视口（每个按钮各占一行），给 sticky composer 单独放宽成同排。

**S6 待补**：UI 上的「中断」按钮只验到它确实发出了 `POST .../abort`（拦 fetch 确认），
没能在一次连续的流式输出里看到它把生成截断——试的时候上游供应商又开始报
`unknown certificate verification error`。端点本身的截断效果已在 S3 补验里确认
（数到 1367/5000 + `MessageAbortedError`）。

**S7 验收（2026-07-26）**：

- **两个会话两个 tab 互不串扰**（M3 验收项）：建两个会话，各自被要求以 `[A]`/`[B]` 前缀
  回复，两个 tab 同时开着、各自挂着 SSE，各发一条消息。结果 tab A 出现 5 次 `[A]`、
  0 次 `[B]`，tab B 出现 5 次 `[B]`、0 次 `[A]`。
- **全程在会话页完成多轮对话，不打开 stock UI**（M3 验收项）：达成。列表 → 详情 → 多轮
  续聊 → 换模型 → 停止/唤醒全部在自建 UI 内完成。
- `pnpm run typecheck`（Worker + web 两个 tsconfig）、`pnpm test`（32 用例）、
  `wrangler deploy --dry-run` 均通过。

**S7 发现**：中断按钮原本挂在折叠后的 `status === 'working'` 上，而发消息会让会话重新经过
`queued → starting`，于是**刚发完消息、agent 正在生成的那几秒里按钮反而消失**——正是最想
用它的时候。改成看容器 runtime 是否 `busy`。

**M3 遗留（不阻塞验收）**：UI 上「中断」按钮把正在流式输出的生成截断，没能在一次连续观测
里拍到——前后试了四次，上游模型供应商都在长生成时报
`unknown certificate verification error`。两半分别验过：端点确实截断（S3 补验，数到
1367/5000 + `MessageAbortedError`），按钮确实发出 `POST .../abort`（拦 fetch 确认），
按钮也确实在容器 busy 时渲染。等供应商稳定后补一次连续观测即可。

**S2 发现（两条都很坑）**：

1. `/event` 的 `directory` 查询参数是必需的——不带它时流里只有 `server.connected` /
   `server.heartbeat` 等服务器级事件，一条会话事件都不会来。
2. **不能自己手写 pump。** 最初用 `ReadableStream` + `pull` 里 `Promise.race(读, 定时器)`
   实现心跳，结果被 Workers runtime 判定为「代码挂死、永不产生响应」而掐断请求
   （日志里的 `The Workers runtime canceled this request…`）。两个诱因叠加：容器被停时
   上游读**既不 resolve 也不 reject，而是永远挂着**；而会话 idle 之后上游只剩
   `server.heartbeat`，全被过滤掉，于是这条流一个字节都不产出。改成
   `upstream.pipeThrough(filter)` 后，runtime 看到的是一条真实 socket 读，问题整体消失，
   心跳与存活探测都不再需要。

原范围：

- 搭 `web/` SPA 脚手架（Vite + React + TS，见 D6），构建产物接入 Wrangler 静态资源托管，
  取代 `hub-ui.ts` 的模板字符串页面；M2 的 composer 一并迁入（现有 composer 与会话卡片
  是过渡实现，`GET /api/catalog` 已经把仓库/模型目录暴露给 SPA）。
- **移动优先布局**：手机是一等场景（路上发任务、看进度、睡前续聊），列表页与会话页
  从一开始就按窄屏设计，桌面是放大适配。
- Hub 首页改为会话列表（状态徽章：working / idle / sleeping / error；最后活动时间）。
- 会话详情页：消息流渲染（`GET /api/sessions/:id/messages` 全量 + `GET /api/sessions/:id/events`
  SSE 增量——Worker 内部消费容器事件流、按会话过滤后转发）、输入框（`promptAsync` 续聊，
  可换模型）、abort 按钮（`session.abort`）。
- 消息渲染范围先覆盖：text（markdown）、reasoning（折叠）、tool 调用（摘要行）、todo；
  其余 part 类型显示占位。
- stock UI 降级为会话页里的"打开完整 IDE"链接（保留全部现有路由）。

验收：

- 全程在会话页完成多轮对话（含中途 abort），不打开 stock UI。
- 两个会话在两个 tab 同时打开互不串扰（沿用 epoch/gateway 隔离）。

### M4 · 休眠可读历史（transcript 镜像） — ✅ 完成（2026-07-26）

实际交付：新增 `src/transcript-mirror.ts`（R2 键位、`StoredTranscriptMirror` 与摘要派生、
读写与按前缀删除，纯函数部分 8 个单测）。**写在 Sandbox DO**：`createOpencodeSession`
成功时顺手把 `{opencodeSessionId, directory}` 落进 DO storage——容器自己建的会话，
不必再从 Hub 把 session record 传下来；`mirrorTranscript()` 读全量消息写
`transcripts/<sessionId>/latest.json`，DO 里只留摘要（会话 id / 导出时间 / 条数 /
最后一条消息时间），正文一律进 R2。触发点两类：quiesce 与 force-stop 在
`createCheckpoint` 之前各导一次（此时 server 还活着），以及活动探测节拍上的周期刷新
（60s，且**只在脏时导**——`promptAsync` 成功或探测到 active 才置脏，所以空闲会话导一次
就停）。**读在 Worker**：`readSessionTranscript` 的两条 sleeping 分支改读镜像，
`source` 增加 `mirror`，响应体加 `mirroredAt`、响应头加
`X-OpenCode-Hub-Transcript-Mirrored-At`。删除走 `doPurgeInstance`，与 backups 同批清理。
SPA 侧休眠横幅从「历史读不到」改成「以下是 <时间> 的历史镜像」，列表卡片在休眠时多一行
「历史镜像 N 条 · 相对时间」（数据搭 `getInstanceRuntimeStatus` 的顺风车，不额外往返）。

本地实测（wrangler dev + 真实容器，全新 `.wrangler/state`）：

- 醒着读 `source: container`；60 秒节拍的 `reason: refresh` 镜像按时出现。
- `POST /api/instances/:id/stop` 后连读 3 次，全是 `state: sleeping` + `source: mirror` +
  完整 2 条历史，且每次都确认 `container: stopped` / `platformRunning: false`——**读镜像
  没有唤醒任何东西**（M4 验收项一）。停机那次导出的 `reason` 确实是 `force-stop`，
  时间戳晚于此前的 refresh。
- 唤醒后续聊到 5 条消息，等到 refresh 镜像追平，然后 `docker kill` 容器模拟 crash：历史
  仍是 5 条，丢的正好是最后一条 assistant 消息在镜像之后新增的 part（验收项二）。
- 删除会话后 `wrangler r2 object get --local` 报 does not exist，transcripts 前缀清干净。

**三个实现上的判断**：

1. **镜像读绕开 runtime gate**。gate 的意义是挡住*外部*请求进入正在关机的容器，而这次导出
   本身就是关机流程的一部分（跑在最后一次 idle 确认与 checkpoint 之间，gate 已是
   `checkpointing`），用 epoch client 会被自己拦住。改为直接读
   `this.persistenceState.container`——那按定义就是本 DO 当前的容器。
2. **周期刷新是 fire-and-forget**。它挂在 `getExecutionSnapshotIfRunning` 上，但用
   `waitUntil` 脱开：coordinator 的空闲判定依赖这个调用够快，而导出失败不该算探测失败。
   停机那次则必须等——所以 `mirrorTranscript` 对 refresh 是"搭车已在跑的那次"，对
   idle-stop/force-stop 是"等前一次跑完再重新导一遍"，避免关机时采用一个稍旧的结果。
3. **脏标记默认为 true**。DO 重启后不信任自己没写过的水位，先补导一次。

**一个顺手的加固**：容器醒着但读消息失败时（S1 原本返回 `state: error` + 空历史），现在也
回落到镜像——crash 实测里第一次读正好命中这条路径，页面显示的是"报错横幅 + 旧历史"而不是
一片空白。

**范围外**：SSE 在休眠时的行为不变（仍是一帧 `sleeping` 就关流）。前端改成只在状态发生
变化时才重新拉取，否则休眠会话每 15 秒重连都会把镜像重下一遍。

原范围：

- quiesce 流水线中（`performQuiesceAndStopIfIdle` 确认空闲之后、checkpoint 之前）导出
  会话消息全量 JSON 到 R2 `transcripts/<sessionId>/`；DO 存摘要与导出水位。
- 醒着时借活动探测节拍周期性刷新镜像（crash 丢失窗口 ≤ 一个探测周期 + 增量）。
- `GET /api/sessions/:id/messages`：醒 → 实时代理；睡 → 读镜像（响应头标注数据来源与
  截止时间）。列表页摘要全部来自镜像/DO，不再触碰容器。
- 删除会话时随备份台账一并清理 transcripts 前缀。

验收：

- 休眠会话点开秒出完整历史，容器保持 stopped（用 `/api/instances` 确认无唤醒）。
- 强杀容器（模拟 crash）后历史最多丢最后一个探测周期内的增量。

### M5 · 无感恢复（睡着直接续聊） — ✅ 完成（2026-07-26）

**实际交付**：`POST /api/sessions/:id/messages` 去掉「容器必须醒着」的 409 门（M3 边界），
只保留「实例不在 `ready`（正在删除）」这一条真正无解的拒绝；其余一律入 SessionAgent 持久队列
并返回 202。**后端投递路径本身几乎没动**——agent 派发时一直都会 `wakeInstanceRuntime`，
M5 做的是把这条一直存在的路径从「竞态」提升为「正路」。abort 仍然要求容器醒着，因为
睡着的会话没有东西可打断，为了中断而启动容器是南辕北辙。

前端 `web/src/components/SessionPage.tsx` 重做：输入框不再按 transcript 状态禁用，休眠时
placeholder 变「发送即唤醒并继续」；发送后立刻插入乐观气泡（`web/src/optimistic.ts`，
纯函数 + 9 个单测），并在派发未完成且容器未就绪时显示「正在唤醒沙箱…」进度条；
`phase === 'failed'` 时页面内直接给出错误与重试按钮。「唤醒并打开 IDE」从主按钮降级为
次要的「打开 IDE ↗」，主按钮永远是「发送」。唤醒期间轮询从 5s 收紧到 2s，
`useTranscript` 新增 `runtimeKey` 参数——容器状态一变就立刻重连 SSE，
不必等 `EventSource` 那 15 秒的 `retry`（那个间隔是为「别人把它弄醒了」设计的，
对「用户刚刚亲手触发的唤醒」太慢）。

**踩到的真问题：连发多条会乱序。** 第一轮实测向休眠会话连发 3 条，transcript 里的顺序是
**2、3、1**，而且三条被合并进同一个 assistant turn。原因是 `prompt_async` 的 204 只表示
「已接收」，不表示「已开始」：三条在毫秒级内打到一个 **idle** 会话上，各自去抢着开一个
turn，于是 OpenCode 记录 user message 的顺序就是竞态结果（三条 created 时间戳只差 44ms）。
D1 spike 结论「排队串行执行」成立的前提是**会话已经 busy**，而那次 spike 正是在 busy 期间
补发的，所以没暴露这条。

修法是把不变式收窄到刚好够用：**绝不同时把两条 prompt 交给一个 idle 会话**。新增
`Sandbox.isOpencodeSessionActive()`（读活动探测同一个 `/session/status`，因此同样不取
work lease、不影响 idle deadline、不能拉起停止的容器），派发批次里每交出一条就等到会话
变 busy 再交下一条；只在「后面还有排队」时才等，所以单条消息这个绝大多数情况零额外开销。
第一条一旦让会话 busy，后面的都落进 OpenCode 自己的有序队列，首次检查即返回。
等待有上界（250ms × 40 = 10s），超时就继续发并告警——顺序值得有限等待，不值得卡死队列。
重测 4/5/6 顺序正确。**注意 5 和 6 仍被合并进一个 assistant turn**：这是 OpenCode 队列的
行为，保证的是顺序而不是「一条消息一个 turn」，已写进 README。

本地实测（wrangler dev + 真实容器，小仓库 octocat/Hello-World 绕开 localBucket 413 限制）：

- 会话跑完 → 停容器 → 确认 `source: mirror` 读到历史 → **直接 POST 消息得到 202，
  phase `queued`、runtime `sleeping`** → 自动 `starting/waking` → `working/busy`，
  pending 归零。transcript 里 `opencodeSessionId` 不变，前两轮对话完整保留，
  新回答接在后面——**上下文来自快照恢复，不是重建**（验收项一）。
- 派发完成后用同一个 `promptId` 重发：202，transcript 消息数不变，没有第二条（验收项二·不重复）。
- 向休眠会话连发 3 条：三条全 202，`pendingPromptCount` 到 3，唤醒后按序投递（验收项二·按序）。
- 被动路径未变：读 transcript / 挂 SSE / 轮询列表在整个过程中依然不唤醒容器（M4 已验，本次未回归改动这些路径）。

**顺手修掉的一个存量 bug**：sticky composer 用的是写死的 `padding-bottom: 140px`，而它在
375px 下实际有 202px 高——对话末尾约 60px 一直藏在输入框后面（M5 又往这个区域加了进度条，
更明显）。改为由会话页测量后写进 `--composer-height`：高度真的会变（控件按宽度换行、
中断/IDE 按钮随状态出现消失、还要算进手机 home indicator 的安全区）。用 `useLayoutEffect`
每次提交后量一次 + `resize` 监听，而不是 `ResizeObserver`——因为**在自动化浏览器面板里
ResizeObserver 的回调根本不投递**（拿一个独立的 observer 对照测试，元素从 202px 变到
301px，回调触发 0 次），验证不了的机制不该发出去。layout effect 这条实测有效：
桌面 154px → 预留 170px，移动 202px → 预留 218px，末条消息底边 580 < 输入框顶边 610。
（`resize_window` 同样不向页面派发 `resize` 事件，手工 `dispatchEvent` 后监听器正常工作，
所以那也是面板的限制而非代码问题。）

**范围外**：`RETRY_BACKOFF_MS` 维持 3 次（5s/20s/60s）。冷启动失败 3 次后停在 `failed`
并在会话页内可见可重试，这是诚实的呈现；在没有证据说明它太紧之前不加旋钮。

原范围：

- `POST /api/sessions/:id/messages`：醒 → 直接 promptAsync；睡 → 202 + SessionAgent
  排队（幂等 id），alarm 驱动 wake → restore → fetch repo → 以同一 `opencodeSessionId`
  续聊（会话状态在快照里，恢复即在）。
- 前端：乐观渲染用户消息 + "正在唤醒沙箱…"进度条 → 醒后无缝接上实时流；唤醒失败在
  会话页内可见可重试。
- 与 idle-stop 的竞态复用现有 coordinator 的 wake 排队语义；聊天视图内不再出现
  410"回 Hub 重新进入"（该路径仅保留给 stock UI）。

验收：

- 对休眠数小时的会话直接输入 → 页面不跳转，自动唤醒并携带完整上下文继续。
- 唤醒期间连发多条消息按序投递、不重复。
- 被动路径行为不变：刷新/挂着 SSE 的会话页永远不唤醒容器。

### M6 · 打磨与增强（按需排期的选做池）

八项全部完成（2026-07-26）。

- ✅ **实时事件镜像**：Sandbox DO 在 gate 进入 `running` 后订阅容器 `/event`，命中本会话的
  帧把 transcript 标脏并触发一次 3s 尾随防抖导出（`reason: 'live'`）。探针驱动的 60s
  刷新退居安全网，并负责 DO 重启后重新挂上订阅；purge 与任何非 running 相位都会断开。
  崩溃丢失窗口从"一个探针间隔"降到"数秒"，列表页的 `mirroredAt`/`messageCount`/用量也
  因此是秒级新鲜的。
- ✅ **代码产出闭环**：新增 `src/session-changes.ts`（纯逻辑：porcelain 解析、shell 转义、
  分支名校验、发布分支决策）+ Sandbox `readSessionChanges`/`publishSessionChanges` +
  `GET /api/sessions/:id/changes`、`POST /api/sessions/:id/publish` + 会话页 `ChangesPanel`。
  **分支决策（补上决策记录里悬着的那条）**：永不提交到默认分支；默认落在
  `opencode/<session-id>`，首次发布创建、之后复用；已在别的分支上则继续用当前分支；
  只有显式传 `branch` 才能改。PR 走镜像内置的 `gh`，已存在的 PR 直接回链不报错。
  未跟踪文件列进文件表但不进 diff（读操作不该动 index），UI 明说这一点。
- ✅ **动态仓库列表**：Worker 调 GitHub API 列出可 push 的仓库（Hub DO 缓存 10 分钟，
  失败回落上次缓存；没有缓存就报错，前端显示错误而不是空下拉），过滤 archived/只读。
  token 按仓库现有惯例直接写在 `src/github-catalog.ts` 里（与 `docker/auth`、`docker/ssh`
  同一档），`GITHUB_TOKEN` secret 可覆盖。实测列出 149 个可用仓库，按最近 push 排序。
  静态目录表已删除——`src/repos.ts` 现在只剩条目类型、安全校验和 `/workspace/<repoKey>`
  路径约定。composer 有「刷新仓库」按钮走 `?refresh=1` 跳过缓存。**顺带修掉一个隐患**：仓库定义现在在建会话时钉死到
  session/instance/Sandbox 三处记录上，`findRepo(repoKey)` 不再出现在服务存量会话的路径上，
  "仓库离开目录表 → 唤醒被拒"这条失败模式消失。
- ✅ **会话管理**：归档（`PATCH /api/sessions/:id {archived}`，列表默认隐藏、发消息自动取消
  归档、容器与历史全留着，与删除明确区分）、重命名（双击标题，`titleLocked` 之后不再被
  自动标题覆盖）、自动标题（镜像携带 OpenCode 自己起的 title，`displayTitle` 优先用它）、
  token 用量与成本（从 assistant 消息累加，进镜像摘要，列表页与会话页都显示）。
  **完成时通知已删除**：浏览器原生 Notification 只在标签页开着时有效，价值太薄，
  本项目暂不做推送。
- ✅ **自建 UI 补齐逃生舱能力**：新增 `src/workspace-files.ts`（纯逻辑：相对路径规范化与
  越界拒绝、目录排序、文本/二进制与截断判定）+ Sandbox `listWorkspaceDirectory`/
  `readWorkspaceFile` + `GET /api/sessions/:id/files`（`&read=1` 读单文件，文本上限
  256 KB，`.git` 不列）；终端走 `GET /api/sessions/:id/terminal` 升级 WebSocket，服务端
  是 SDK 的 `sandbox.terminal()` PTY 直通，浏览器端直接用 SDK 自带的 `SandboxAddon` +
  xterm.js（协议不自己实现）。会话页新增 `WorkspacePanel`（文件/终端两个页签，默认收起，
  xterm 走 lazy chunk 不进入口包）。
  **活着的终端不被误判空闲**：探针只看 OpenCode 执行状态，shell 里跑测试对它是隐形的，
  所以终端面板每 45 秒 `POST /api/sessions/:id/keepalive` 续一次 work lease，且从不显式
  归还——关标签页即停止续租，容器回到正常的 10 分钟空闲窗口。
- ✅ **退役 stock UI**：删掉 `src/stock-ui.ts` 整个文件与 `/ui/`、`/assets/`、`/gateway/`、
  `/hub/bootstrap.js` 四条路由、`_hub`/`_runtime` 入口、入口 bundle 正则补丁、
  `/instances/:id` 重定向；`POST /api/instances/:id/wake` 不再返回 `launchUrl`；
  列表页与会话页的"打开完整 IDE"按钮下线。**公网不再有任何通往容器的路由**：浏览器只
  见 `/api/*` 与 SPA 外壳，进容器一律是 Worker 内部的 DO RPC。顺带删掉随之失效的
  `openCodeRouteRequiresWorkLease`（网关的租约策略）及其单测。
- ✅ **冷启动测量与优化**：wake 分阶段埋点（容器启动+快照恢复 / 仓库置备 / OpenCode 启动
  与总耗时），存 Sandbox DO 并随 `runtime.lastWake` 搭现有 runtime status 的顺风车出去，
  会话页标题下显示上次冷启动耗时、tooltip 给分段。容器本来就醒着的"只重启 server"记为
  `cold: false` 且不显示，免得把平均数拉好看。两处实打实的优化：resumed checkout 的
  `git fetch` 不再挡在 server 启动前面（改为并行，取二者较慢者）；快照排除可再生缓存
  （`.opencode-state/cache`）——快照体积就是恢复时间，恢复时间就是冷启动。
  压缩格式故意没动：SDK 默认已是 lz4，解压最快，而解压这一侧才落在冷启动上。
- ✅ **清理**：`LogtoSandbox` 与模板镜像早在 2026-07-26 的 M1 收尾里就已退役（migration
  `v6` 已应用），本轮补掉的是随 stock UI 一起失效的死代码与全套文档收敛
  （README 的路由章节重写为「一个 origin、一套 API」，新增 Cold start 小节；
  AGENTS.md 新增「不给容器留公网路由」约束）。

M6 偏差与备注：

- 动态仓库列表用的是 Worker 侧的 token，不是原计划的"容器内 `gh` 凭据"。
  原因是目录表在**建会话时**就要用，而那正是还没有任何容器的时刻；镜像里的 `gh` 只能在
  醒着的容器里用，为了列个下拉去冷启一个容器不划算。clone 仍走镜像里的 SSH key，
  所以 token 决定"能选什么"、key 决定"能 clone 什么"，两者要分别授权。
- 动态目录表下 `repoKey` 由仓库名派生，与原静态表可能不同（`logto-io/cloud` 现在是
  `cloud`，静态表里是 `logto-cloud`）。存量会话不受影响：目录由 `repoKey` 直接推导，
  remote 与默认分支改为问 checkout 自己（`origin/HEAD`），整条服务存量会话的路径上不再
  需要目录表。只有新建会话会用新 key。
- 因此目录表现在只在「建会话」这一步是必需的。仓库改名、权限撤销、GitHub 挂掉都不会
  影响已经跑起来的会话——这是删掉静态兜底之后仍然敢只留一个数据源的前提。
- 通知没有做 webhook/push（原范围里写的是 "webhook / push"）。浏览器通知是自包含、
  零外部依赖的一半；真正的离线推送要引入推送服务与订阅存储，等有实际需要再排。
- `tsconfig.json` 打开了 `allowImportingTsExtensions`：`src/github-catalog.ts` 需要在运行时
  从 `src/repos.ts` 取校验函数，而 node 的测试运行器按字面解析相对路径。
- 终端与文件浏览的**服务端逻辑有单测（21 例路径/列表/截断），但整条链路尚未在真实容器上
  跑过**——本轮改动没有做本地 `wrangler dev` + 容器实测，PTY 的 `sessionId` 是否总能命中
  容器默认 session、`cd` 到 checkout 的首条命令表现如何，都要在首次实跑时确认。
- 冷启动优化同理：埋点已经在，但**还没有生产数字**。"镜像瘦身"这条因此仍然悬着——在
  知道恢复/启动各占多少之前，砍镜像里的 `gh`/wrangler 是凭感觉动刀。等 `lastWake` 攒够
  样本再决定。
- 终端只在容器醒着时可用（睡着返回 409），没有做"打开终端即唤醒"。理由与 abort 一致：
  socket 已经连上却卡几十秒，体感是挂了而不是在唤醒。

## 五、风险与开放问题

| 风险 | 影响 | 对策 |
|------|------|------|
| ~~`promptAsync` 在 1.18.4 的确切语义未验证~~ | ~~M2 根基~~ | 已消解：spike + M2 本地端到端均验证通过 |
| 冷启动耗时决定"无感"体感 | M5 体验 | 已在 UI 明示进度（唤醒进度条 + 乐观气泡）；耗时优化进 M6 |
| 长对话镜像体积 | M4 存储 | 正文进 R2、DO 只存索引；分页读取 |
| 一实例被 stock UI 开出多个 OpenCode session | 镜像/状态聚焦 | 会话页只聚焦主 `opencodeSessionId`，其余 session 照常被活动探测保活，镜像可顺带导出 |
| Containers 并发实例上限与 standard-4 成本 | 规模化 | 会话数上来后评估更小 instance type / 并发上限与排队 |
| 本地 dev（localBucket）restore 大工作区报 413 | 仅本地联调 | SDK 0.12.3 本地模式经容器文件 API 推送归档有体积上限；生产 presigned R2 路径不受影响。本地用小仓库验证快照链路（已记入 README） |
| 单账号多端同时操作同一会话 | 一致性 | 依赖 OpenCode server 端事件序；UI 以事件流为准做最终一致 |

## 六、工程纪律（每个里程碑通用）

- 交付前 `pnpm test && pnpm run typecheck`；生命周期相关改动补充 `test/` 下的单测。
- DO 新类走 wrangler migration 递增编号（下一个是 v5），只加不改。
- 行为变化同步更新 README 与 AGENTS.md。
- 每个里程碑合并后在本文档勾掉对应条目并记录偏差，本文档即进度台账。
