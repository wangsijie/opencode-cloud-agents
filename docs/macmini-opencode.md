# Mac Mini OpenCode Web

Mac Mini 上常驻一个 OpenCode Web 服务，对外地址是 `https://opencode.vwnpc.com`。完整的 FRP、nginx、Cloudflare 和网络故障排查文档由 [`v2ray-docker/docs/macmini-opencode.md`](https://github.com/wangsijie/v2ray-docker/blob/master/docs/macmini-opencode.md) 管理；这里只记录 OpenCode 配置同步所需的最小操作。

## 登录与服务位置

```bash
ssh -p 7101 sijie@129.211.13.146
```

| 项 | 路径 |
|----|------|
| OpenCode | `/Users/sijie/.opencode/bin/opencode` |
| Live 配置 | `/Users/sijie/.config/opencode/opencode.jsonc` |
| LaunchAgent | `/Users/sijie/Library/LaunchAgents/com.vwnpc.opencode-web.plist` |
| 密码文件 | `/Users/sijie/.config/opencode/web.password` |
| 日志 | `/Users/sijie/logs/opencode-web.log`、`/Users/sijie/logs/opencode-web.err` |

## 更新 OpenCode 配置

[`src/opencode-config.ts`](../src/opencode-config.ts) 是 provider、模型、能力、limits、cost 和 variants 的 source of truth。Mac Mini 的 `opencode.jsonc` 是派生副本。

1. 先在本仓库修改 `src/opencode-config.ts` 并运行：

   ```bash
   pnpm test
   pnpm run typecheck
   ```

2. 将等价配置写入 Mac Mini 的 `/Users/sijie/.config/opencode/opencode.jsonc`。如从本机准备了完整 JSONC 文件，可使用：

   ```bash
   scp -P 7101 <prepared-opencode.jsonc> \
     sijie@129.211.13.146:/Users/sijie/.config/opencode/opencode.jsonc
   ```

3. 支持图片的模型必须显式声明：

   ```jsonc
   "attachment": true,
   "modalities": {
     "input": ["text", "image"],
     "output": ["text"]
   }
   ```

4. 在 Mac Mini 上修正权限并重启：

   ```bash
   chmod 600 /Users/sijie/.config/opencode/opencode.jsonc
   launchctl kickstart -k gui/$(id -u)/com.vwnpc.opencode-web
   ```

## 验证

```bash
curl -u opencode:"$(cat /Users/sijie/.config/opencode/web.password)" \
  http://127.0.0.1:4096/global/health

curl -fsS -u opencode:"$(cat /Users/sijie/.config/opencode/web.password)" \
  http://127.0.0.1:4096/provider \
  | jq '[.all[] | .id as $provider | .models[] | {
      provider: $provider,
      model: .id,
      image: .capabilities.input.image
    }]'
```

健康检查应返回 `"healthy": true`；所有支持图片的模型应返回 `"image": true`。
