# OpenCode Fleet Configuration

This repository is the source of truth for OpenCode configuration across every managed runtime. It has two equally important roles:

1. build and deploy OpenCode Cloud on Cloudflare Workers and Sandbox;
2. define the provider, model, capability and version settings that are synchronized to OpenCode installations on other machines.

## Canonical sources

| Concern | Canonical file |
|---------|----------------|
| Providers, models, limits, costs, variants and modalities | [`src/opencode-config.ts`](../src/opencode-config.ts) |
| Sandbox OpenCode version | [`Dockerfile`](../Dockerfile) |
| SDK version | [`package.json`](../package.json) and [`pnpm-lock.yaml`](../pnpm-lock.yaml) |
| Mac Mini service operations | [`docs/macmini-opencode.md`](macmini-opencode.md) |

Live configuration files on machines are deployment targets, not sources of truth. Do not copy a live machine configuration back over the canonical configuration without first reviewing and expressing the intended change here.

## Managed runtimes

| Runtime | Live configuration | Update mechanism |
|---------|--------------------|------------------|
| Cloudflare Sandbox | `OPENCODE_CONFIG` supplied by the Worker | Change `src/opencode-config.ts`, verify, deploy |
| Mac Mini OpenCode Web | `~/.config/opencode/opencode.jsonc` | Semantically sync from `src/opencode-config.ts`, restart LaunchAgent, verify `/provider` |

Add every future machine/runtime to this table and create a dedicated operations document under `docs/` before treating it as managed.

## Synchronization contract

When provider or model configuration changes:

1. Update `src/opencode-config.ts` first.
2. Keep every image-capable model explicit:

   ```ts
   attachment: true,
   modalities: {
     input: ['text', 'image'],
     output: ['text']
   }
   ```

3. Keep OpenCode and SDK versions aligned unless a documented platform constraint requires otherwise.
   Note that the Cloudflare Hub also derives its session model picker from this file: a model removed
   here disappears from the composer, and any existing session pinned to it fails on its next dispatch.
   Retire a model only after its sessions are finished or repointed.
4. Run `pnpm test` and `pnpm run typecheck`.
5. Deploy Sandbox changes with `pnpm run deploy` when production rollout is requested.
6. Sync the equivalent configuration to each documented machine, restart its OpenCode service, and verify the runtime provider catalog. For image models, `capabilities.input.image` must be `true`.
7. Update the affected operations document and record any intentional drift.

Provider credentials are intentionally stored in this private repository. Never paste them into external tools, logs, issues, or public repositories.

## Ownership boundary with `v2ray-docker`

This repository owns OpenCode application configuration and operations. The private [`v2ray-docker`](https://github.com/wangsijie/v2ray-docker) repository remains the source of truth for proxy networking, FRP tunnels, nginx ingress topology and the underlying VPS nodes. Cross-repository documentation should link to the owner instead of duplicating configuration.
