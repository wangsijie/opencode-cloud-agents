# 多 Provider Sandbox:任务拆解

> 进度:任务 1、2、3、4、4.5、5、6、7、8 已完成(协议见 `protocol/PROTOCOL.md`;provider 数据管道已入库;docker settings + catalog `providers` 已上线,UI 消费留到任务 8;Worker B 见 `host/`;`opencode-cloud-sessions` 已建、站点 transcripts + attachments 已搬。任务 5 已上生产(2026-07-28,站点版本 `3f53a21a`):站点去掉 containers 绑定与 `BaseSandbox` 继承,全部容器原语走 `src/host-client.ts` → Worker B。生产验证结果见任务 5 的"线上验证"一节——冷启动、proxy、SSE、idle-stop+checkpoint、以及睡眠后从快照唤醒全部通过,**purge 与 publish 尚未线上验证**)。任务 6 站点侧已实现,能力开关全部走 `HostClient.supportsSnapshots`,但要等任务 9 才能与真 agent 端到端验证。任务 7 的 agent 见 `agent/`,已对本地 Docker 跑通全协议(见该节),但还没有被站点驱动过。任务 8 的 UI 已实现并在 `pnpm dev:mock` 走查通过,顺带补上了设置页此前完全缺失的 Docker 分组——生产的 docker 配置是手写进 D1 的。只剩任务 9 的后半段:让站点真正驱动一次 docker session。

## 目标架构(已确认)

站点与容器调度分离、provider 完全对等:

```
Worker A(站点):web/API/D1/R2 + 编排 DO(Sandbox 纯状态机、Lifecycle、SessionAgent、Hub)
   ├─ Service Binding fetch ──→ Worker B(opencode-sandbox-host):CloudflareSandboxHost DO
   │                             (extends BaseSandbox,containers 绑定 + R2 快照,哑原语服务器)
   └─ 公网 HTTPS + bearer ────→ Mac mini / Linux 的 agent(Node 零依赖,docker CLI,volume 持久化)
```

一套 HTTP 形态的 "Sandbox Host 协议",两个 Host 实现,站点侧一个 `HostClient` 按 session 的 provider 切换传输。通信选型结论:协议保持 HTTP(请求-响应 + SSE 全覆盖,Workers 对 gRPC 支持差、WS 需自建复用);CF 内部走 service binding(不出公网、零握手),远程走 HTTPS(Caddy HTTP/2);延迟靠协议内批量端点解决(唤醒 4~6 次往返)。

关键决策备忘:provider 建 session 时选、存 sessions 表可混用;docker 用 named volume 持久化、无 R2 快照(mini 磁盘丢了就是丢了,可接受);两 provider 都保留 transcript 到 R2 镜像(写入方始终是站点的 Sandbox DO,经协议 `proxy/` 读容器的 OpenCode API——agent 不碰 R2、无 R2 凭证;推论:停容器必须永远由站点发起,agent 不做任何自主生命周期决策,否则 `idle-stop` 前的完整导出时序不成立);R2 按所有权拆桶(见下);不考虑版本偏移;`Sandbox` DO 保留类名与 storage(gate/identity/备份台账原地不动,快照句柄经协议显式传递——台账由我们自己管理、`restoreBackup(handle)` 接受显式句柄,已在源码验证 :111-113/:2450)。

---

## 任务 1:确定 Sandbox Host 通信协议 ← 第一个任务

**目标**:协议定稿,后续所有任务以它为契约。

**内容**:
1. 前置验证(结论写进协议文档的"设计依据"):
   - SDK dist 确认 `createBackup`/`restoreBackup(handle)` 不依赖 SDK 私有 DO storage 状态(决定快照端点"句柄显式传递"是否成立;若不成立,后备:台账 key 迁入 Worker B)。
   - SDK `createOpencodeServer` 的 env 推导细节(`OPENCODE_CONFIG_CONTENT`、各 `<PROVIDER>_API_KEY`、ai-gateway 变量),为 `opencodeServerEnv(config)` 纯函数定形。
   - Service binding fetch 的流式 Response(SSE)直通可行性。
2. 新建 `protocol/`:TS 类型 + 路由常量 + `PROTOCOL.md` 文档。端点集(定稿以本任务为准):
   `GET /healthz`(含 `capabilities: {snapshots}`)、`POST /sessions/:id/ensure`、`GET /sessions/:id`、`POST /sessions/:id/stop`、`DELETE /sessions/:id`、`POST /sessions/:id/exec`(`sh -lc`,支持整段脚本,输出上限 ~2MB)、`POST /sessions/:id/files/write-batch`、`files/read`(utf-8/base64)、`files/exists`、`files/list`(形状 = `ContainerFileInfo`)、`POST /sessions/:id/opencode/start`(等就绪,180s)、`ANY /sessions/:id/proxy/*`(SSE 直通,未运行 → 503 `CONTAINER_NOT_RUNNING`)、`POST /sessions/:id/snapshot` / `snapshot/restore {handle}`(仅 snapshots 能力)。
   错误码约定、鉴权约定(service binding 免鉴权;远程 bearer + 恒定时间比较)、session id 规则 `^[A-Za-z0-9_-]{1,64}$`。

**交付**:`protocol/` 目录(types.ts、routes.ts、PROTOCOL.md)。零行为变化。
**验收**:`pnpm test` + typecheck 绿;文档能独立指导 agent 实现(不需要读站点代码)。
**依赖**:无。

## 任务 2:provider 数据管道

**内容**:`migrations/0003_session_provider.sql`(`provider TEXT NOT NULL DEFAULT 'cloudflare'`);`hub-rows.ts`(SessionRow + 两投影)、`instances.ts`、`sessions.ts` 加 `provider`;`hub-store.ts` `createSession` 接受并写入、传 `initializeInstance` 第 4 参;`sandbox.ts` `InstanceIdentity` 加 `provider?`(缺省 cloudflare);`api-sessions.ts` `readCreateSessionInput` 接受可选 `provider`(暂时只接受 `'cloudflare'`,docker 留到任务 6 放开)。
**交付/验收**:迁移 + 类型 + 测试(hub-rows 投影、存量行默认值);`wrangler d1 migrations apply --local` 验证;全默认 cloudflare,零行为变化。
**依赖**:无(可与任务 1 并行)。

## 任务 3:docker settings + catalog providers

**内容**:`SETTING_KEYS` += `docker.agent-url` / `docker.agent-token` / `docker.image`;`settings-schema.ts` group 加 `'docker'`,三 descriptor 均非必填(URL 校验 https origin、token secret、镜像默认 `opencode-session:latest`);`isDockerProviderConfigured(env)`;catalog 端点暴露 `providers: SessionProvider[]`(此时恒 `['cloudflare']`,配置后含 docker——UI 消费留到任务 8)。
**交付/验收**:settings-schema 测试扩展;设置页能存取(descriptor 驱动,无 UI 新代码)。
**依赖**:无。

## 任务 4:Worker B(opencode-sandbox-host)落地

**内容**:`host/` 目录(wrangler.jsonc:containers 绑定 `CloudflareSandboxHost` + image 指根 `Dockerfile` + R2 `BACKUP_BUCKET` + migration v1,**不配公网 route**;index.ts 路由 `/sessions/:id/*` → `idFromName(id)` stub;host.ts 哑宿主实现协议端点:Base 原语、`createOpencodeServer`、`getTcpPort(4096).fetch` 反代(绕过 auto-boot)、`terminateContainerBounded` 逻辑、`createBackup/restoreBackup(handle)`)。CI 拆分:改 `Dockerfile/docker/host/` 才部署 B,否则只部署站点(沿用 deploy.yml 既有判定模式)。**过渡期站点 wrangler 的 containers 绑定保留不动**(站点仍走旧路径,B 部署后暂无人调用),站点侧删除留到任务 5。
**交付/验收**:Worker B 独立部署成功;从站点 Worker 加临时 debug 路由(或 wrangler tail + 内部调用)对 B 做冒烟:ensure → exec → 写读文件 → opencode/start → proxy → snapshot/restore → stop → delete。
**依赖**:任务 1。

## 任务 4.5:R2 按所有权拆桶(小 PR,排在任务 5 之前)

**背景**:`opencode-cloud-backups` 现在塞了三种业务——`backups/`(SDK 容器快照 + `meta.json` 台账)、`transcripts/`(会话镜像)、prompt attachments(临时图片),而 `host/wrangler.jsonc` 绑的是同一个桶。任务 5 之后所有权彻底错位:`backups/` 只有 Worker B 写,其余只有 Worker A 写,但两边都持有对方数据的完整读写权。

**方向**:`opencode-cloud-backups` 归 Worker B(快照),新建站点桶(`opencode-cloud-sessions`)装 `transcripts/` + attachments。**不能反过来**——`BACKUP_BUCKET_NAME` 是 SDK 读去做 presigned 上传的(`wrangler.jsonc:11`),改快照桶名要动 SDK 假设 + 存量句柄,风险白担;transcripts 是我们自己 `put`/`get`,换桶只是改绑定名。

**内容**:建新桶;站点加 `SESSION_BUCKET` 绑定;`transcript-mirror.ts` 的读写点(`sandbox.ts:2058`、`api-sessions.ts:1113`)+ attachments 的读写清扫(`api-sessions.ts:327`、`session-agent.ts:414/563`)改用新绑定;存量 `transcripts/` 一次性 copy 到新桶(几百 KB 级,脚本跑一次即可;attachments 是临时数据,直接切不迁移)。此时站点仍保留 `BACKUP_BUCKET`(快照还没搬走),任务 5 再删。

**交付/验收**:`pnpm test` + typecheck 绿;部署后睡眠 session 的历史仍可读(即 copy 生效)。未动继承与 containers,零风险。
**依赖**:无(可与任务 4 并行)。

## 任务 5:站点切换到 HostClient(CF-only)⚠ 风险最高,单独 PR ✅ 已实现,未部署

**内容**:
- `src/host-client.ts`:唯一协议客户端,传输可插(service binding stub / fetch+baseUrl+bearer),含 `opencodeServerEnv(config)`、proxy URL 重写(剥 epoch header)。
- `sandbox.ts` 去 `extends BaseSandbox` 改普通 `DurableObject`(类名/storage 不变):约 20 处 `persistenceState.container?.running` → 本地真值 `host:runtime` + 探针经 `GET /sessions/:id` 校准;5 处 `getTcpPort(4096)` → `host.proxyFetch`;`containerFetch` override 删除,SSE 改新编排方法 `streamOpencodeEvents`(`api-sessions.ts` 改调);凭证注入/provision/changes/publish 方法体抽 `src/runtime-ops.ts`(接 HostClient + 窄接口,批量化:一次 write-batch + 一次脚本 exec);wake/quiesce/purge 改走协议(snapshot 句柄进出台账);gate/epoch/drain 一行不动。
- 解析点(`instance-access.ts`、`instance-runtime.ts`、`hub-store.ts`、`hub.ts`、`lifecycle.ts`)改 `env.Sandbox.getByName(id)`——`getSandbox` 内部就是 `idFromName(id.toLowerCase())`,实例 id 本来就全小写,DO 身份不变。
- 站点 wrangler.jsonc:删 containers,加 `services: [{binding:"SANDBOX_HOST", service:"opencode-sandbox-host"}]`;删 `BACKUP_BUCKET_NAME` / `PERSISTENCE_LOCAL_BUCKET`;`pnpm run types`。

**实际落地的两处偏离**(都是有意的):
1. **站点保留 `BACKUP_BUCKET` 绑定**。原计划要一并删掉,但 PROTOCOL.md 明确把"快照删除"留在调用方:句柄台账在 `Sandbox` DO storage 里,purge 要按 `backups/<id>/` 前缀删对象、还要扫 `meta.json` 找孤儿。要删站点绑定就得给协议加 snapshot delete/list 两个端点(以及 agent 的对应实现),在本就最高风险的一步里不值得。所以只删 `BACKUP_BUCKET_NAME`(那是 SDK presign 用的,SDK 已经在 B 了),绑定留着**只用于删**,AGENTS.md 写清楚了。
2. **CI 简化**。站点不再有 containers,`deploy:worker-only` / `--containers-rollout=none` 那条分支变成死代码,已删;站点每次都 `pnpm run deploy`(不再构建镜像,反而更快),容器 rollout 只由 `Dockerfile/docker/host/protocol` 触发的 Worker B 部署决定。

顺手修掉的既有 bug:`ensureRepoProvisioned` 声明成 `async` 又返回 promise,`await` 会把内层 fetch 一起等掉——注释里说的"与 server start 重叠"从来没生效过。现在 `provisionRepository` 返回 `{fetching?}` 包一层。

**交付/验收**:`pnpm test` + typecheck 绿(新增 `test/host-client.test.mjs` 13 例、`test/runtime-ops.test.mjs` 15 例)✅。收尾审计 `grep -n "persistenceState.container\|getTcpPort\|BaseSandbox\|containerFetch" src/` ✅ 全空。部署时线上 0 session,所以"移除 container application 会让在跑容器退役"这个风险没有实际发生。

### 线上验证(2026-07-28,站点版本 `3f53a21a`)

证据来自两个 Worker 的 `wrangler tail` 与直接读生产 R2,不依赖站点登录。

**已验证 ✅**
- **冷启动全链路**:`ensure` → `files/exists`(marker)→ `files/write-batch`(凭证一次批量)→ `exec`(`rm -rf skills && rm -f AGENTS.md` 合成一条)→ `git clone --depth 1`(852ms)→ `opencode/start`(host 日志 "OpenCode server started successfully")。协议每个端点都被真实打到,两个 Worker 零 error。
- **proxy 路由**:`session/status`、`api/session/active`、`session/:id/message`、`prompt_async` 往返正常。
- **SSE 多跳直通**:R2 里的 mirror 写着 `reason: "live"`,而 `live` 只有事件订阅从 `/event` 消费到帧后才会写 —— 容器 → Worker B → 站点 DO → 浏览器这条流没被缓冲。站点 tail 里也能看到新的 `Sandbox.streamOpencodeEvents`。(`proxy/event` 不出现在 tail 里是正常的:长连接只在结束时落一行。)
- **idle-stop + checkpoint,且顺序正确**:mirror `reason: idle-stop` 写于 09:45:53 → marker `write-batch` 09:45:54 → `exec sync` 09:45:55 → `snapshot` Ok 09:45:55 → `stop` Ok 09:45:59。即"OpenCode 还活着时先导完整 transcript,再 checkpoint,最后停"——AGENTS.md 那条不变量成立。

- **唤醒-从-快照恢复**(本次改动风险最高的一环,已通过):`ensure` → `files/exists`(marker 不在)→ `snapshot/restore` Ok → 凭证 → `files/exists('.git')` → **`git fetch origin --prune` 而不是 `git clone`** → `opencode/start`。跑 fetch 就说明 checkout 是从快照回来的;restore 失败的话这里会重新 clone、session 会变 `lost`。更硬的证据在 R2:mirror 的消息数 6 → 9 且 `reason` 回到 `live`,即恢复出来的是**同一个 OpenCode 会话**、历史接上了,事件订阅也重新挂上了。
- 全程唯一一条 warning 是 idle-stop 停容器时的 `Live transcript event subscription ended: Stream was cancelled.`,发生在完整导出完成一秒之后,是设计中的降级路径。

**未验证 ⚠**
- **purge**:`DELETE /sessions/:id` 清容器,以及站点侧删 `backups/` 与 `transcripts/` 前缀的 R2 对象。
- **publish**:`runtime-ops` 的 git 路径只有单测覆盖,线上没跑过。

## 任务 6:docker provider 接通(站点侧)✅ 已实现,未部署

**内容**:`HostClient` 的 docker 传输(settings 读配置,DO 内存缓存 ~60s;agent 503 `CONTAINER_NOT_RUNNING` → 本地真值置 false);编排层能力开关:无 snapshots → wake 跳过 restore(workspace-loss = "volume 被重建")、睡眠跳过 snapshot、checkpoint 降级 `sync` + mirror、purge 走 `DELETE`(容器+volume);`getInstanceRuntimeStatus` 加 `provider`;`api-sessions.ts` 放开 `provider: 'docker'`(未配置 → 400)。

**实际落地**:
- `resolveHostClient` 改成 **async**(docker 要读 settings),返回 `Promise<HostClient>`;`HostClient` 构造多一个可选 `image`,`ensure()` 自动带上(显式传参优先)。未配置 docker 抛 `HostUnavailableError`——与"未知 provider"分开,因为 session 已在库里,清掉配置后每次唤醒都应该报一条人能看懂的错。
- `sandbox.ts` 的 `private get host()` 变成 `private async host()`,带 `HOST_CLIENT_TTL_MS = 60_000` 的内存缓存(过期只重读 settings,DO 身份不变);18 处调用点改 `await`。能力判断统一走 `hostSupportsSnapshots()`,**不看 provider 名字**。
- 三个能力分支:`restoreWorkspace`(无 snapshots 就不读台账,marker 不在 = volume 被重建 → 仍记 `workspaceLost`)、新增 `persistWorkspaceBeforeStop`(有快照就 checkpoint,没有就只 `sync`;两条路径都排在 transcript 导出之后)、`discoverOwnedBackups`(无快照直接返回空,省掉一次全 `backups/` 前缀扫描)。手动 checkpoint 端点对 docker 明确报错而不是静默成功。
- `unknownRuntimeStatus(deleting, provider)` 多带一个 provider:DO 连不上时,Hub 行里的 provider 是唯一还知道的那个字段。
- `readCreateSessionInput` 接 `listSessionProviders(env)` 的结果做校验,而不是硬编码 `'cloudflare'`——配置完 docker 不用重新部署就能建 session。

**交付/验收**:`pnpm test` 226 例绿(host-client 新增 5 例:两种 provider 的传输/能力/image、未配置、未知 provider);`pnpm run typecheck` 三个 project 全绿。此时功能可用但无 UI 入口(API 可建 docker session)。**站点侧完成,但在任务 7 的 agent 存在之前无法端到端验证**。
**依赖**:任务 3、5。

**已知遗留**(不属于本任务,记在这里):删除一个 docker session 要经 `DELETE /sessions/:id`,所以操作员清掉 docker 配置后,存量 docker session 会卡在 `deleting`。任务 9 运维文档里写清"先删 session 再清配置"。

## 任务 7:Mac mini agent 实现 ✅ 已实现,本地 Docker e2e 42/42 通过

**内容**:`agent/server.mjs`(路由 + bearer 恒定时间比较)、`agent/docker.mjs`(docker CLI 包装,纯参数构造独立)、`agent/session-image/Dockerfile`(`node:22-bookworm-slim` + git/ssh/gh/opencode-ai@1.18.4/pnpm 同 pin,COPY `docker/ssh/*`,构建上下文 = 仓库根)、`agent/launchd/*.plist`、`agent/README.md`(node/docker/launchd/Caddy,`/proxy/` 不设空闲超时)。容器 `oc-session-<id>` / volume `oc-vol-<id>` / `-p 127.0.0.1:0:4096`(macOS 必须发布端口)。**agent 不做任何自主生命周期决策**:不加 idle reaper,restart policy 不设开机自启以外的东西——停容器永远等站点的 `POST /stop`,否则 `idle-stop` 前的 transcript 完整导出会漏掉最后一段对话(volume 还在,不丢数据,但睡眠期间看到的历史缺一截)。

**实际落地的偏离**(都是有意的):
- **OpenCode server 的 env 写进容器内的 600 文件再 `set -a; . file`,不走 `docker exec -e`**。env 里是每个 provider 的 API key,而 docker 的 argv 在这台机器上人人可以从 `ps` 读到。文件落在 `/root/`(容器自己的层,不是 volume),所以不进任何持久化。
- **发布端口是查出来的,不是记住的**。`-p 127.0.0.1:0:4096` 每次启动都换端口,`docker port` 的结果只缓存 3 秒,并在每个生命周期调用后作废。缓存久了的风险是真的:容器崩溃 + restart policy 拉起后旧端口会被释放,理论上可能被另一个 session 的容器拿走,那就是把一个会话的流量代理进另一个会话的 workspace。
- **`ensure` 会替换镜像已过期的已停止容器**(运行中的不动),这就是镜像升级路径——workspace 在 volume 上,所以换镜像不需要迁移。
- **`--restart unless-stopped` 是 agent 唯一持有的生命周期意见**:重启/重开机后把容器拉回来,但绝不会复活站点主动停掉的那个。
- 镜像比计划多装 `procps`(agent 用 `pgrep` 判断 OpenCode 是否已在跑)、coreutils `timeout`、GNU `find -printf`,以及 wrangler(与 CF 镜像对齐)。这三个是 agent 对镜像的额外要求,已写进 `agent/README.md`。

**e2e 抓到的三个 bug**(都只有真跑才看得见,单测全绿的情况下):
1. **proxy 自己掐死自己的上游**。`req.on('close')` 在无 body 的 GET 被读完时立刻触发——早于容器应答——于是每个代理请求都在 `response` 还没出现时 `upstream.destroy()`,表现为健康容器的 503 `socket hang up`。判据要挂在 `response` 上,看 `writableFinished`。
2. **`timeout --signal=KILL` 退出码是 137 不是 124**。124 只在默认信号下才有,所以 `EXEC_TIMEOUT` 从来不会触发,超时的 exec 看起来只是"退出码 137 的失败命令"。改成 `--kill-after=5`(TERM 打头),并把 124/137 都算超时、再用实际耗时做二次判据。
3. **`docker exec` 打到已停止容器退出码是 1 不是 125**。原来只认 125,于是 `CONTAINER_NOT_RUNNING` 从来不会触发——而站点的 `host:runtime` 本地真值正是靠这个 503 校准的。现在 1/125 都认,但要求 stderr 带 docker CLI 自己的 `Error response from daemon:` 前缀,免得容器里某条命令打印同样的字被误判。

**交付/验收**:`test/agent-docker.test.mjs` 17 例(参数构造、容器脚本、截断、文本/二进制判定、listing 解析、inspect 映射、端口解析,外加一条把 `agent/server.mjs` 的路由表和 `protocol/routes.ts` 逐条对齐的防漂移用例)✅;`pnpm test` 243 例 + `tsc` 三个 project 全绿 ✅。`node agent/e2e.mjs` 对本地 Docker(29.5.2)跑通全序列 42/42 ✅:ensure(冷启/幂等/volume 复用)→ exec(退出码、stdout/stderr 分离、超时 408)→ write-batch(utf-8/base64/mode 600)→ read/exists/list(含 404 两种)→ snapshot 501 → opencode/start(首启 + 复用)→ proxy → **SSE 流边开边到** → stop → 停止后 primitive 503 → 重新 ensure(**workspace 从 volume 活下来**)→ delete(容器 + volume 都没了,幂等)。脚本在 `agent/`,不进 `pnpm test`(CI 没有 Docker)。
**依赖**:任务 1(仅协议)。

**未验证 ⚠**:agent 只被 `agent/e2e.mjs` 驱动过,还没有被站点的 `HostClient` 驱动过——真实的凭证注入、clone、publish、transcript 镜像都留在任务 9。

## 任务 8:Web UI ✅ 已实现,未部署

**内容**:`web/src/api.ts`(`SessionView.provider`、catalog `providers`、create 入参);新建页 provider pill(仅 `providers.length > 1` 时显示,默认 cloudflare);列表/详情 "docker" 徽标;docker 隐藏 checkpoint 按钮改显 volume 持久化说明;设置页 Docker 分组确认渲染;`web/src/mock/router.ts` + fixtures 同步。

**实际落地的三处偏离**:
1. **设置页不是 descriptor 驱动的**(任务 3 里的假设是错的)。`SettingsPage.tsx` 是一张手写的 `SECTIONS` 表加一个 section 一个组件,所以 docker 三个 key 此前在 UI 里根本没有入口——生产上的 `docker.agent-url` / `docker.agent-token` 是直接写进 D1 的。本任务新增 `DockerSection`(URL + token + image 三个字段,token 是 secret:留空表示"别动",不是"清空";清 URL = 关掉 provider,配套写了"先删 session 再清配置"的提示,对应任务 6 的已知遗留)。
2. **没有 checkpoint 按钮可以隐藏**。手动 checkpoint 只有 `POST /api/instances/:id/checkpoint` 这条 API,UI 从来没暴露过。所以"volume 持久化说明"落在了状态徽标背后的 InstanceModal 里:多两行 `Sandbox` / `Workspace`,并把冷启动分段的 `Container + snapshot` 在无快照时改成 `Container start`。`lost` 卡片的文案也按 provider 分叉("容器没 checkpoint 就重启了" vs "workspace volume 被重建了")。
3. **pill 的显示条件是 `providers.length > 1` 而不是 `includes('docker')`**——含义一样,但读起来是"有得选才给选",而不是给 docker 开的后门。另加一个 effect:catalog 里的 provider 消失时(操作员清了配置)选择回落到第一个,否则会拿一个 Hub 必然 400 的值去建 session。

mock 侧:catalog 的 `providers` 由 mock settings 派生(和 Hub 一样),所以"清掉 Docker 配置 → composer 的 pill 消失"这条路径在 `pnpm dev:mock` 里能走;新增 `ses_docker` fixture(睡眠中的 docker session,覆盖两处徽标 + volume 文案)。

**交付/验收**:`pnpm test` 243 例 + `pnpm run typecheck` 三个 project 全绿 ✅。`pnpm dev:mock` 浏览器走查 ✅:composer pill(Cloudflare/Docker)、建出来的 session 头部与列表都带 docker 徽标、`ses_docker` 的 InstanceModal 显示 `Sandbox: Docker` / `Workspace: Kept on a named volume between containers` / `Container start`、CF session 对照显示 `Cloudflare` / `Snapshotted when the container sleeps` / `Container + snapshot`、设置页 Docker 分组存取正常且清掉 URL 后 pill 消失,控制台零 error。
**依赖**:任务 2、3(mock 可先行,真实数据依赖 6)。

## 任务 9:端到端联调

**内容**:mini 上装 agent(launchd + Caddy + token,步骤见 `agent/README.md`),构建 session 镜像;先在 mini 上跑一遍 `node agent/e2e.mjs` 确认那台机器的 Docker/镜像没问题,再让站点接手;站点配置 docker settings;跑双 provider 完整生命周期(docker:创建 → 发消息 → 空闲睡眠 → mirror 读 transcript → 唤醒 → publish → 删除,mini 上确认容器+volume 已清;CF:回归确认);按 `WakeTimings` 调超时;文档化运维(token 轮换 60s 缓存生效、镜像升级流程)。
**依赖**:全部。

**已完成的前半段(2026-07-28,mini 上)**:agent 装在 `~/srv/opencode-cloud`,launchd user agent 监听 `127.0.0.1:8787`,token 在 `~/.config/opencode-agent/token`,镜像已构建;`node agent/e2e.mjs` 对那台机器的真 Docker(29.5.2)42/42 通过;TLS 前端 `docker-agent-1.cloud-agents.dev` 已就位,从公网驱动完整会话(ensure → opencode/start → proxy → SSE → delete)通过,**SSE 首帧 109ms、连续读 180 秒不断流**(OpenCode 每 10 秒一个 `server.heartbeat`,所以这条流实际上永远不空闲,反代的空闲回收构不成风险);站点的 `docker.agent-url` / `docker.agent-token` 已写入生产 D1。部署改为 CI 驱动,见 `.github/workflows/deploy.yml` 的 `docker-agent` job。

**剩下的**:让站点真正驱动一次 docker session(凭证注入、clone、发消息、睡眠、mirror、唤醒、publish、删除),以及 CF 侧回归。

两个非显然的坑,都会静默失败:
- **非交互 ssh 下 `docker build` 拉基础镜像会失败**。Docker Desktop 在 `~/.docker/config.json` 写了 `credsStore: desktop`,而 `docker-credential-desktop` 只在 `/Applications/Docker.app/Contents/Resources/bin`——登录 shell 找得到,`ssh host 'docker build …'` 找不到,报的是一句看不出所以然的 `error getting credentials`。CI 的 build 步骤显式把这个目录加进了 PATH。
- **mini 必须开自动登录**。Docker Desktop 是 GUI 用户级进程,没有登录会话就没有 daemon,断电重启后 agent 会一直被 launchd 拉起、但每个 session 都醒不了。

---

## 依赖图与建议节奏

```
任务1(协议) ──→ 任务4(Worker B) ──→ 任务5(站点切换 ✅) ──→ 任务6(docker 接通) ──→ 任务9(e2e)
任务2(数据) ──────────────────────↗            任务7(agent,可并行) ────↗
任务3(settings) ────────────────────────────────↗  任务8(UI ✅) ───────↗
任务4.5(拆桶,与 4 并行) ──────────↗
```

每个任务一个 PR,任务 5 是唯一的高风险步骤(部署后需存量回归验证);其余均为增量、可随时中断。

## 风险备忘

- 任务 5:containers 迁移会让在跑的 CF 容器退役(等价"动镜像的部署",AGENTS.md 既有约定);去继承后漏改调用点会直接编译报错。
- SSE 多跳(容器 → B/agent → 站点 DO → 浏览器):service binding 流式直通在任务 1 验证;agent 不缓冲,Caddy 不设空闲超时。
- 部署顺序:先 B 后 A(A 的 service binding 依赖 B 存在)。
