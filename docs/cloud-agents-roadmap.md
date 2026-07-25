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
| 认证 | ✅ Cloudflare Access JWT 校验，单入口 |
| stock UI 单域名代理 | ✅ `/ui/<id>/<epoch>/...` + `/gateway/<id>/<epoch>/...` + bootstrap 补丁 |
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

### D1 · 用 `session.promptAsync` 派发任务

SDK v2 已提供 `session.promptAsync`（提交后立即返回，agent loop 在容器内 server 侧运行）。
因此 Worker/DO 不需要为一次几十分钟的任务持有长连接；现有活动探测会把运行中的会话判为
busy 并自动保活，干完自然进入 10 分钟空闲倒计时。**M2 第一件事是对 1.18.4 做一次
promptAsync 语义冒烟**（断连后是否继续、重复提交行为、与 `/api/session/active` 探测的一致性）。

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
- 由此 `LogtoSandbox` 类和模板镜像机制走向退役（迁移完成后清理）。

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

### 决策记录（2026-07-25 已拍板）

| 问题 | 决定 |
|------|------|
| 开工顺序 | 最先执行 promptAsync spike（约半天），验证 D1 后再按 M1 起推进 |
| 前端栈 | React + Vite + TS（评估过 Solid 借鉴 opencode share 页，按日常栈定 React） |
| repo 列表来源 | 静态 `src/repos.ts` 起步，动态化留给 M6 |
| 分支策略 | 不自动建分支，默认分支直接干；产出管理放 M6 设计 |
| 空闲休眠时长 | 维持 10 分钟；M5 上线后再评估是否缩短 |
| 移动端 | 手机是一等场景，M3 起移动优先布局 |
| 多用户 | 单用户模型，不预留 owner 字段 |

## 四、里程碑

> 开工顺序：最先做 M2 里的 promptAsync spike（见决策记录），然后 M1 → M2 → M3 → M4 → M5。

### M1 · 运行时 repo 置备（去模板化） — 约 2–4 天

范围：

- 新增 `src/repos.ts` 仓库目录表；`InstanceRecord` 增加 `repoKey`（模板字段保留用于旧实例）。
- 容器侧 `ensure-repo` 步骤接入 `wakeForLifecycle`（restore 之后、标记 running 之前）：
  缺失则 `git clone --depth 1`，存在则 `git fetch`；失败进入现有错误上报路径。
- 创建 API/对话框：repo 下拉替换模板选择；新建实例一律用 base 镜像。
- 迁移：存量 `logto-v1` 实例照常工作，不强迁。

验收：

- 新建任选 repo 的实例，首次唤醒后 `/workspace/<repoKey>` 就位并可在 stock UI 里干活。
- stop 后再次唤醒：目录来自快照恢复，且 fetch 拿到了远端新提交。
- `pnpm test && pnpm run typecheck` 通过；README 模板章节更新。

### M2 · 会话化创建：repo + 模型 + prompt 直接开工 — 约 3–5 天

范围：

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

### M3 · 自定义会话页（醒着时的聊天视图） — 约 4–6 天

范围：

- 搭 `web/` SPA 脚手架（Vite + React + TS，见 D6），构建产物接入 Wrangler 静态资源托管，
  取代 `hub-ui.ts` 的模板字符串页面；M2 的 composer 一并迁入。
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

### M4 · 休眠可读历史（transcript 镜像） — 约 3–5 天

范围：

- quiesce 流水线中（`performQuiesceAndStopIfIdle` 确认空闲之后、checkpoint 之前）导出
  会话消息全量 JSON 到 R2 `transcripts/<sessionId>/`；DO 存摘要与导出水位。
- 醒着时借活动探测节拍周期性刷新镜像（crash 丢失窗口 ≤ 一个探测周期 + 增量）。
- `GET /api/sessions/:id/messages`：醒 → 实时代理；睡 → 读镜像（响应头标注数据来源与
  截止时间）。列表页摘要全部来自镜像/DO，不再触碰容器。
- 删除会话时随备份台账一并清理 transcripts 前缀。

验收：

- 休眠会话点开秒出完整历史，容器保持 stopped（用 `/api/instances` 确认无唤醒）。
- 强杀容器（模拟 crash）后历史最多丢最后一个探测周期内的增量。

### M5 · 无感恢复（睡着直接续聊） — 约 3–4 天

范围：

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

- **实时事件镜像**：醒着时事件流持续写镜像，历史零丢失，列表页"正在输入"级别的实时性。
- **代码产出闭环**（按决策记录整体在此设计）：是否/何时建分支、changed-files/diff 视图
  （SDK 已有 `session.diff` / `vcs.diff`）、一键 commit / push / 建 PR（`gh` 已内置）。
- **动态仓库列表**：用 `gh` 凭据调 GitHub API 替换静态 `repos.ts`。
- **会话管理**：归档/删除、自动标题、token 用量与成本展示、完成时通知（webhook / push）。
- **冷启动优化**：测量并压缩 wake→可响应耗时（镜像瘦身、快照策略）。
- **自建 UI 补齐逃生舱能力**：diff 视图、终端（PTY WebSocket 已可代理）、文件浏览。
- **退役 stock UI**：补齐后删除 `/ui/` 资产代理、bootstrap、入口 bundle 补丁，
  `/gateway/` 收敛为 Worker 内部通信；OpenCode 升级不再受 UI 补丁牵制。
- **清理**：退役 Logto 模板镜像与 `LogtoSandbox`、文档收敛。

## 五、风险与开放问题

| 风险 | 影响 | 对策 |
|------|------|------|
| `promptAsync` 在 1.18.4 的确切语义未验证 | M2 根基 | spike 已列为最先执行项；若行为不符，退路是容器内 `nohup curl` 自持投递进程 |
| 冷启动耗时决定"无感"体感 | M5 体验 | 先测量并在 UI 明示进度；优化项进 M6 |
| 长对话镜像体积 | M4 存储 | 正文进 R2、DO 只存索引；分页读取 |
| 一实例被 stock UI 开出多个 OpenCode session | 镜像/状态聚焦 | 会话页只聚焦主 `opencodeSessionId`，其余 session 照常被活动探测保活，镜像可顺带导出 |
| Containers 并发实例上限与 standard-4 成本 | 规模化 | 会话数上来后评估更小 instance type / 并发上限与排队 |
| 单账号多端同时操作同一会话 | 一致性 | 依赖 OpenCode server 端事件序；UI 以事件流为准做最终一致 |

## 六、工程纪律（每个里程碑通用）

- 交付前 `pnpm test && pnpm run typecheck`；生命周期相关改动补充 `test/` 下的单测。
- DO 新类走 wrangler migration 递增编号（下一个是 v5），只加不改。
- 行为变化同步更新 README 与 [opencode-fleet.md](opencode-fleet.md)（AGENTS.md 的同步契约）。
- 每个里程碑合并后在本文档勾掉对应条目并记录偏差，本文档即进度台账。
