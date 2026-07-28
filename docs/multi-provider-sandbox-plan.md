# 多 Provider Sandbox:任务拆解

> 进度:任务 1、2、3 已完成(协议见 `protocol/PROTOCOL.md`;provider 数据管道已入库;docker settings + catalog `providers` 已上线,UI 消费留到任务 8);其余任务待做。

## 目标架构(已确认)

站点与容器调度分离、provider 完全对等:

```
Worker A(站点):web/API/D1/R2 + 编排 DO(Sandbox 纯状态机、Lifecycle、SessionAgent、Hub)
   ├─ Service Binding fetch ──→ Worker B(opencode-sandbox-host):CloudflareSandboxHost DO
   │                             (extends BaseSandbox,containers 绑定 + R2 快照,哑原语服务器)
   └─ 公网 HTTPS + bearer ────→ Mac mini / Linux 的 agent(Node 零依赖,docker CLI,volume 持久化)
```

一套 HTTP 形态的 "Sandbox Host 协议",两个 Host 实现,站点侧一个 `HostClient` 按 session 的 provider 切换传输。通信选型结论:协议保持 HTTP(请求-响应 + SSE 全覆盖,Workers 对 gRPC 支持差、WS 需自建复用);CF 内部走 service binding(不出公网、零握手),远程走 HTTPS(Caddy HTTP/2);延迟靠协议内批量端点解决(唤醒 4~6 次往返)。

关键决策备忘:provider 建 session 时选、存 sessions 表可混用;docker 用 named volume 持久化、无 R2 快照;两 provider 都保留 transcript 到 R2 镜像;不考虑版本偏移;`Sandbox` DO 保留类名与 storage(gate/identity/备份台账原地不动,快照句柄经协议显式传递——台账由我们自己管理、`restoreBackup(handle)` 接受显式句柄,已在源码验证 :111-113/:2450)。

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

## 任务 5:站点切换到 HostClient(CF-only)⚠ 风险最高,单独 PR

**内容**:
- `src/host-client.ts`:唯一协议客户端,传输可插(service binding stub / fetch+baseUrl+bearer),含 `opencodeServerEnv(config)`、proxy URL 重写(剥 epoch header)。
- `sandbox.ts` 去 `extends BaseSandbox` 改普通 `DurableObject`(类名/storage 不变):约 20 处 `persistenceState.container?.running` → 本地真值 `host:runtime` + 探针经 `GET /sessions/:id` 校准;5 处 `getTcpPort(4096)` → `host.proxyFetch`;`containerFetch` override 删除,SSE 改新编排方法 `streamOpencodeEvents`(`api-sessions.ts:934` 改调);凭证注入/provision/changes/publish 方法体抽 `src/runtime-ops.ts`(接 HostClient + 窄接口,批量化:一次 write-batch + 一次脚本 exec);wake/quiesce/purge 改走协议(snapshot 句柄进出台账);gate/epoch/drain 一行不动。
- 解析点(`instance-access.ts:39`、`instance-runtime.ts:98`、`hub-store.ts:499`、`hub.ts:101`)改普通 DO stub。
- 站点 wrangler.jsonc:删 containers,加 `services: [{binding:"SANDBOX_HOST", service:"opencode-sandbox-host"}]`;`pnpm run types`。
**交付/验收**:`pnpm test` + typecheck 绿(新增 `test/host-client.test.mjs`、`test/runtime-ops.test.mjs`);部署后存量 CF session 全流程无回归:唤醒(台账句柄经 B 恢复)→ 对话 → 空闲睡眠 → mirror 读 → 再唤醒 → checkpoint → publish → 删除。收尾审计 `grep -n "persistenceState.container\|getTcpPort\|BaseSandbox" src/`。
**依赖**:任务 2、4。

## 任务 6:docker provider 接通(站点侧)

**内容**:`HostClient` 的 docker 传输(settings 读配置,DO 内存缓存 ~60s;agent 503 `CONTAINER_NOT_RUNNING` → 本地真值置 false);编排层能力开关:无 snapshots → wake 跳过 restore(workspace-loss = "volume 被重建")、睡眠跳过 snapshot、checkpoint 降级 `sync` + mirror、purge 走 `DELETE`(容器+volume);`getInstanceRuntimeStatus` 加 `provider`;`api-sessions.ts` 放开 `provider: 'docker'`(未配置 → 400)。
**交付/验收**:host-client docker 传输测试(stub fetch);能力开关分支测试;typecheck 绿。此时功能可用但无 UI 入口(API 可建 docker session)。
**依赖**:任务 3、5。

## 任务 7:Mac mini agent 实现(可与 5、6 并行)

**内容**:`agent/server.mjs`(路由 + bearer 恒定时间比较)、`agent/docker.mjs`(docker CLI 包装,纯参数构造独立)、`agent/session-image/Dockerfile`(`node:22-bookworm-slim` + git/ssh/gh/opencode-ai@1.18.4/pnpm 同 pin,COPY `docker/ssh/*`,构建上下文 = 仓库根)、`agent/launchd/*.plist`、`agent/README.md`(node/docker/launchd/Caddy,`/proxy/` 不设空闲超时)。容器 `oc-session-<id>` / volume `oc-vol-<id>` / `-p 127.0.0.1:0:4096`(macOS 必须发布端口)。
**交付/验收**:`test/agent-docker.test.mjs`(参数构造/截断/二进制判定);开发机对本地 Docker 跑通脚本化 e2e:ensure → exec → write-batch → opencode/start → proxy SSE → stop → delete(脚本进 agent/,不进 `pnpm test`)。
**依赖**:任务 1(仅协议)。

## 任务 8:Web UI

**内容**:`web/src/api.ts`(`SessionView.provider`、catalog `providers`、create 入参);新建页 provider pill(仅 `providers.includes('docker')` 时显示,默认 cloudflare);列表/详情 "docker" 徽标;docker 隐藏 checkpoint 按钮改显 volume 持久化说明;设置页 Docker 分组确认渲染;`web/src/mock/router.ts` + fixtures 同步。
**交付/验收**:`pnpm dev:mock` 走查全部新 UI 状态。
**依赖**:任务 2、3(mock 可先行,真实数据依赖 6)。

## 任务 9:端到端联调

**内容**:mini 上装 agent(launchd + Caddy + token),构建 session 镜像;站点配置 docker settings;跑双 provider 完整生命周期(docker:创建 → 发消息 → 空闲睡眠 → mirror 读 transcript → 唤醒 → publish → 删除,mini 上确认容器+volume 已清;CF:回归确认);按 `WakeTimings` 调超时;文档化运维(token 轮换 60s 缓存生效、镜像升级流程)。
**依赖**:全部。

---

## 依赖图与建议节奏

```
任务1(协议) ──→ 任务4(Worker B) ──→ 任务5(站点切换) ──→ 任务6(docker 接通) ──→ 任务9(e2e)
任务2(数据) ──────────────────────↗            任务7(agent,可并行) ────↗
任务3(settings) ────────────────────────────────↗  任务8(UI) ──────────↗
```

每个任务一个 PR,任务 5 是唯一的高风险步骤(部署后需存量回归验证);其余均为增量、可随时中断。

## 风险备忘

- 任务 5:containers 迁移会让在跑的 CF 容器退役(等价"动镜像的部署",AGENTS.md 既有约定);去继承后漏改调用点会直接编译报错。
- SSE 多跳(容器 → B/agent → 站点 DO → 浏览器):service binding 流式直通在任务 1 验证;agent 不缓冲,Caddy 不设空闲超时。
- 部署顺序:先 B 后 A(A 的 service binding 依赖 B 存在)。
