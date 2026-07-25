import { REPOS } from './repos';

export function renderHubHtml(): Response {
  const html = HUB_HTML.replace(
    '<!--WORKSPACE_OPTIONS-->',
    workspaceOptionsHtml()
  );
  return new Response(html, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'none'"
      ].join('; '),
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    }
  });
}

/** Render one radio card per catalog repository for the creation dialog. */
function workspaceOptionsHtml(): string {
  return REPOS.map(
    (repo) => `<label class="template-option">
            <input type="radio" name="workspace" value="${escapeHtml(repo.repoKey)}" />
            <span class="template-card">
              <span>
                <span class="template-name">${escapeHtml(repo.displayName)}</span>
                <span class="template-description">首次唤醒时克隆 <code>${escapeHtml(repo.cloneUrl)}</code>，之后唤醒自动 fetch 更新。</span>
                <span class="template-path">/workspace/${escapeHtml(repo.repoKey)}</span>
              </span>
            </span>
          </label>`
  ).join('\n          ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const HUB_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenCode Hub</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0d10;
        --panel: #111419;
        --panel-hover: #151920;
        --line: #242a33;
        --line-strong: #343c48;
        --text: #f0f2f5;
        --muted: #9199a6;
        --accent: #d6ff53;
        --accent-ink: #121608;
        --danger: #ff6b73;
        --warn: #f5b83d;
        --ok: #66d692;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at 15% -10%, rgba(214,255,83,.08), transparent 32rem),
          var(--bg);
        color: var(--text);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button, a { font: inherit; }
      .shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 34px 0 64px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
      .brand { display: flex; align-items: center; gap: 13px; }
      .mark {
        display: grid; place-items: center; width: 38px; height: 38px;
        border: 1px solid #3e4927; border-radius: 10px; background: #171d10;
        color: var(--accent); font: 700 19px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      h1 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
      .subtitle { margin-top: 3px; color: var(--muted); font-size: 12px; }
      .button {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        min-height: 38px; padding: 0 15px; border: 1px solid var(--line-strong);
        border-radius: 9px; background: #191d23; color: var(--text); cursor: pointer;
        text-decoration: none; transition: 140ms ease;
      }
      .button:hover:not(:disabled) { background: #222832; border-color: #4b5564; transform: translateY(-1px); }
      .button:disabled { opacity: .45; cursor: wait; }
      .button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); font-weight: 650; }
      .button.danger { color: var(--danger); }
      .button.small { min-height: 32px; padding: 0 11px; border-radius: 7px; font-size: 12px; }
      .hero { margin: 66px 0 28px; display: flex; align-items: end; justify-content: space-between; gap: 20px; }
      .hero h2 { margin: 0; font-size: clamp(30px, 5vw, 52px); letter-spacing: -.055em; font-weight: 590; }
      .hero p { margin: 12px 0 0; max-width: 610px; color: var(--muted); line-height: 1.6; font-size: 14px; }
      .summary { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(325px, 1fr)); gap: 14px; }
      .card {
        position: relative; padding: 20px; border: 1px solid var(--line); border-radius: 13px;
        background: linear-gradient(145deg, rgba(255,255,255,.018), transparent 60%), var(--panel);
        min-height: 210px; transition: 150ms ease;
      }
      .card:hover { border-color: var(--line-strong); background-color: var(--panel-hover); }
      .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
      .instance-name { font: 600 16px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
      .instance-id { margin-top: 7px; color: #737c89; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; white-space: nowrap; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #667080; box-shadow: 0 0 0 3px rgba(102,112,128,.12); }
      .dot.running, .dot.busy { background: var(--ok); box-shadow: 0 0 0 3px rgba(102,214,146,.12); }
      .dot.idle { background: var(--accent); box-shadow: 0 0 0 3px rgba(214,255,83,.12); }
      .dot.waking, .dot.quiescing, .dot.checkpointing, .dot.stopping, .dot.deleting { background: var(--warn); box-shadow: 0 0 0 3px rgba(245,184,61,.12); }
      .dot.error { background: var(--danger); box-shadow: 0 0 0 3px rgba(255,107,115,.12); }
      .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 25px 0 20px; }
      .meta-label { color: #697280; font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
      .meta-value { margin-top: 6px; color: #c0c6cf; font-size: 12px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 15px; border-top: 1px solid var(--line); }
      .empty { grid-column: 1 / -1; padding: 70px 24px; border: 1px dashed var(--line-strong); border-radius: 13px; text-align: center; color: var(--muted); }
      .empty strong { display: block; margin-bottom: 9px; color: var(--text); font-size: 16px; }
      .error-box { margin: 20px 0; padding: 12px 14px; border: 1px solid rgba(255,107,115,.35); border-radius: 9px; background: rgba(255,107,115,.07); color: #ffb2b7; font-size: 13px; }
      .hidden { display: none !important; }
      .skeleton { min-height: 210px; overflow: hidden; }
      .skeleton::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.035), transparent); animation: shimmer 1.3s infinite; }
      @keyframes shimmer { to { transform: translateX(100%); } }
      dialog { width: min(440px, calc(100% - 32px)); border: 1px solid var(--line-strong); border-radius: 13px; background: #14181e; color: var(--text); padding: 22px; box-shadow: 0 24px 80px #000a; }
      dialog::backdrop { background: #050608cc; backdrop-filter: blur(3px); }
      dialog h3 { margin: 0 0 10px; font-size: 18px; }
      dialog p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
      dialog code { color: var(--text); }
      #create-dialog { width: min(610px, calc(100% - 32px)); }
      .template-options {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
        margin: 20px 0 0; padding: 0; border: 0;
      }
      .visually-hidden {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
      }
      .template-option { position: relative; cursor: pointer; }
      .template-option input { position: absolute; width: 1px; height: 1px; opacity: 0; }
      .template-card {
        position: relative; display: flex; min-height: 150px; padding: 17px;
        border: 1px solid var(--line-strong); border-radius: 10px; background: var(--panel);
        transition: 140ms ease;
      }
      .template-card > span { display: flex; flex: 1; flex-direction: column; min-width: 0; }
      .template-option:hover .template-card { border-color: #566171; background: var(--panel-hover); }
      .template-option input:focus-visible + .template-card { outline: 2px solid var(--accent); outline-offset: 3px; }
      .template-option input:checked + .template-card {
        border-color: var(--accent); background: linear-gradient(145deg, rgba(214,255,83,.08), transparent 70%), var(--panel);
      }
      .template-option input:checked + .template-card::after {
        content: "\2713"; position: absolute; top: 13px; right: 13px;
        display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
        background: var(--accent); color: var(--accent-ink); font-size: 12px; font-weight: 800;
      }
      .template-option input:disabled + .template-card { opacity: .45; cursor: wait; }
      .template-name { display: block; padding-right: 28px; font: 650 16px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .template-description { display: block; margin-top: 11px; color: var(--muted); font-size: 12px; line-height: 1.55; }
      .template-path { display: block; margin-top: auto; padding-top: 17px; color: #c0c6cf; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .dialog-error { margin-top: 14px; padding: 10px 12px; border: 1px solid rgba(255,107,115,.35); border-radius: 8px; background: rgba(255,107,115,.07); color: #ffb2b7; font-size: 12px; }
      .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
      @media (max-width: 650px) {
        .shell { width: min(100% - 24px, 1180px); padding-top: 20px; }
        header, .hero { align-items: stretch; }
        .hero { margin-top: 46px; flex-direction: column; }
        .grid { grid-template-columns: 1fr; }
        .template-options { grid-template-columns: 1fr; }
        .button.primary { padding-inline: 12px; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <div class="brand">
          <div class="mark">&gt;_</div>
          <div><h1>OpenCode Hub</h1><div class="subtitle">Cloudflare Sandbox instances</div></div>
        </div>
        <button class="button primary" id="create" aria-haspopup="dialog" aria-controls="create-dialog">＋ 新建实例</button>
      </header>

      <section class="hero">
        <div>
          <h2>你的工作空间</h2>
          <p>每个实例拥有独立容器、OpenCode 状态和 R2 持久化快照。停止实例会保留数据；删除实例会同时销毁容器并清空其备份。</p>
        </div>
        <div class="summary" id="summary">正在读取实例…</div>
      </section>

      <div class="error-box hidden" id="error" role="alert"></div>
      <section class="grid" id="instances">
        <article class="card skeleton"></article><article class="card skeleton"></article>
      </section>
    </main>

    <dialog id="create-dialog" aria-labelledby="create-title" aria-describedby="create-description">
      <form id="create-form">
        <h3 id="create-title">选择工作区</h3>
        <p id="create-description">仓库实例使用统一基础镜像，在首次唤醒时把所选仓库克隆到工作区。</p>
        <fieldset class="template-options">
          <legend class="visually-hidden">工作区</legend>
          <label class="template-option">
            <input type="radio" name="workspace" value="" checked autofocus />
            <span class="template-card">
              <span>
                <span class="template-name">空白</span>
                <span class="template-description">基础 OpenCode 环境，进入后是一个空白工作区。</span>
                <span class="template-path">/workspace</span>
              </span>
            </span>
          </label>
          <!--WORKSPACE_OPTIONS-->
        </fieldset>
        <div class="dialog-error hidden" id="create-error" role="alert"></div>
        <div class="dialog-actions">
          <button class="button small" id="create-cancel" type="button">取消</button>
          <button class="button small primary" id="create-confirm" type="submit">创建实例</button>
        </div>
      </form>
    </dialog>

    <dialog id="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description">
      <h3 id="delete-title">删除这个实例？</h3>
      <p id="delete-description">将永久销毁 <code id="delete-name"></code> 的容器，并删除 R2 中所有已跟踪的持久化快照。此操作不可撤销。</p>
      <div class="dialog-actions">
        <button class="button small" id="delete-cancel">取消</button>
        <button class="button small danger" id="delete-confirm">永久删除</button>
      </div>
    </dialog>

    <script>
      const list = document.querySelector('#instances')
      const summary = document.querySelector('#summary')
      const errorBox = document.querySelector('#error')
      const createButton = document.querySelector('#create')
      const createDialog = document.querySelector('#create-dialog')
      const createForm = document.querySelector('#create-form')
      const createCancel = document.querySelector('#create-cancel')
      const createConfirm = document.querySelector('#create-confirm')
      const createError = document.querySelector('#create-error')
      const templateInputs = [...createForm.querySelectorAll('input[name="workspace"]')]
      const deleteDialog = document.querySelector('#delete-dialog')
      const deleteName = document.querySelector('#delete-name')
      const deleteConfirm = document.querySelector('#delete-confirm')
      let instances = []
      let deleting = null
      let busy = false
      let launching = null

      const lifecycleStatuses = {
        sleeping: { label: '已休眠', css: 'sleeping' },
        waking: { label: '正在唤醒', css: 'waking' },
        busy: { label: '任务执行中', css: 'busy' },
        idle: { label: '空闲', css: 'idle' },
        quiescing: { label: '正在等待静默', css: 'quiescing' },
        checkpointing: { label: '正在备份', css: 'checkpointing' },
        stopping: { label: '正在停止', css: 'stopping' },
        error: { label: '运行异常', css: 'error' }
      }

      function node(tag, className, text) {
        const element = document.createElement(tag)
        if (className) element.className = className
        if (text !== undefined) element.textContent = text
        return element
      }

      function formatTime(value) {
        if (!value) return '—'
        return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      }

      function lifecycleFor(instance) {
        const runtime = instance.runtime || {}
        const value = runtime.lifecycle
        if (typeof value === 'string' && lifecycleStatuses[value]) return value

        const container = runtime.container
        if (container === 'running' || container === 'healthy') return 'idle'
        if (container === 'stopping') return 'stopping'
        if (container === 'unknown') return 'error'
        return 'sleeping'
      }

      function idleDeadlineFor(instance) {
        const runtime = instance.runtime || {}
        return runtime.idleDeadlineAt || null
      }

      function formatIdleDeadline(instance) {
        const phase = lifecycleFor(instance)
        const value = idleDeadlineFor(instance)
        if (!value) {
          if (phase === 'busy') return '任务结束后开始计时'
          if (phase === 'sleeping') return '已关闭'
          if (phase === 'waking') return '唤醒后开始计时'
          if (phase === 'quiescing' || phase === 'checkpointing' || phase === 'stopping') return '正在关闭'
          return '—'
        }

        const deadline = new Date(value)
        if (Number.isNaN(deadline.getTime())) return '—'
        const remainingMs = deadline.getTime() - Date.now()
        const relative = remainingMs <= 0
          ? '即将关闭'
          : remainingMs < 60 * 1000
            ? '不到 1 分钟后'
            : Math.ceil(remainingMs / (60 * 1000)) + ' 分钟后'
        return relative + ' · ' + formatTime(value)
      }

      function statusFor(instance) {
        if (instance.lifecycle === 'delete_failed') return { label: '删除失败', css: 'error' }
        if (instance.lifecycle === 'deleting') return { label: '正在删除', css: 'deleting' }
        return lifecycleStatuses[lifecycleFor(instance)]
      }

      function action(label, action, kind = '') {
        const button = node('button', 'button small ' + kind, label)
        button.disabled = busy
        button.addEventListener('click', action)
        return button
      }

      function render() {
        list.replaceChildren()
        const running = instances.filter((item) => ['running', 'healthy'].includes(item.runtime.container)).length
        summary.textContent = instances.length + ' 个实例 · ' + running + ' 个运行中'
        if (!instances.length) {
          const empty = node('div', 'empty')
          empty.append(node('strong', '', '还没有实例'), document.createTextNode('点击“新建实例”开始。'))
          list.append(empty)
          return
        }

        for (const instance of instances) {
          const card = node('article', 'card')
          const head = node('div', 'card-head')
          const identity = node('div')
          identity.append(node('div', 'instance-name', instance.name), node('div', 'instance-id', instance.id))
          const status = statusFor(instance)
          const statusNode = node('div', 'status')
          statusNode.append(node('span', 'dot ' + status.css), document.createTextNode(status.label))
          head.append(identity, statusNode)

          const meta = node('div', 'meta')
          const image = node('div')
          const workspaceText = instance.repoKey
            ? instance.repoKey + ' → /workspace/' + instance.repoKey
            : instance.imageKey
          image.append(node('div', 'meta-label', instance.repoKey ? 'Repo' : 'Image'), node('div', 'meta-value', workspaceText))
          const backup = node('div')
          const backupText = instance.runtime.persistence.hasBackup
            ? '已备份 · ' + formatTime(instance.runtime.persistence.lastCheckpointAt)
            : '尚无快照'
          backup.append(node('div', 'meta-label', 'Persistence'), node('div', 'meta-value', backupText))
          const idleDeadline = node('div')
          idleDeadline.append(node('div', 'meta-label', 'Idle shutdown'), node('div', 'meta-value', formatIdleDeadline(instance)))
          meta.append(image, backup, idleDeadline)

          const actions = node('div', 'actions')
          const available = instance.lifecycle === 'ready'
          const enter = action(launching === instance.id ? '正在进入…' : '进入 OpenCode ↗', () => wake(instance), 'primary')
          enter.disabled = busy || !available
          actions.append(enter)
          if (available && ['running', 'healthy'].includes(instance.runtime.container)) {
            actions.append(action('保存快照', () => command(instance.id, 'checkpoint')), action('停止', () => command(instance.id, 'stop')))
          }
          actions.append(action(instance.lifecycle === 'delete_failed' ? '重试删除' : '删除', () => askDelete(instance), 'danger'))
          card.append(head, meta, actions)
          if (instance.lastError) {
            const detail = node('div', 'instance-id', instance.lastError)
            detail.style.color = 'var(--danger)'
            detail.style.marginTop = '12px'
            card.append(detail)
          }
          list.append(card)
        }
      }

      function showError(error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error)
        errorBox.classList.remove('hidden')
      }

      function showCreateError(error) {
        createError.textContent = error instanceof Error ? error.message : String(error)
        createError.classList.remove('hidden')
      }

      function syncBusyState() {
        createButton.disabled = busy
        createCancel.disabled = busy
        createConfirm.disabled = busy
        createForm.setAttribute('aria-busy', String(busy))
        for (const input of templateInputs) input.disabled = busy
      }

      async function api(path, options) {
        const response = await fetch(path, options)
        const body = response.status === 204 ? null : await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error || '请求失败 (' + response.status + ')')
        return body
      }

      async function refresh(silent = false) {
        try {
          instances = await api('/api/instances')
          if (!silent) errorBox.classList.add('hidden')
          render()
        } catch (error) {
          if (!silent) showError(error)
        }
      }

      async function mutate(work, handleError = showError) {
        if (busy) return false
        busy = true
        syncBusyState()
        render()
        try { await work(); await refresh(); return true }
        catch (error) { handleError(error); await refresh(true); return false }
        finally { busy = false; syncBusyState(); render() }
      }

      async function command(id, commandName) {
        await mutate(() => api('/api/instances/' + encodeURIComponent(id) + '/' + commandName, { method: 'POST' }))
      }

      async function wake(instance) {
        if (busy || instance.lifecycle !== 'ready') return
        busy = true
        launching = instance.id
        syncBusyState()
        render()
        try {
          const result = await api('/api/instances/' + encodeURIComponent(instance.id) + '/wake', { method: 'POST' })
          if (!result || typeof result.launchUrl !== 'string' || !result.launchUrl) {
            throw new Error('唤醒成功，但服务器未返回访问地址')
          }
          location.assign(result.launchUrl)
        } catch (error) {
          showError(error)
          await refresh(true)
          launching = null
          busy = false
          syncBusyState()
          render()
        }
      }

      function askDelete(instance) {
        deleting = instance
        deleteName.textContent = instance.name
        deleteDialog.showModal()
      }

      createButton.addEventListener('click', () => {
        createError.classList.add('hidden')
        createDialog.showModal()
      })
      createCancel.addEventListener('click', () => createDialog.close())
      createForm.addEventListener('submit', async (event) => {
        event.preventDefault()
        if (busy) return
        const workspace = new FormData(createForm).get('workspace')
        if (typeof workspace !== 'string') {
          showCreateError('请选择一个工作区')
          return
        }
        createError.classList.add('hidden')
        const payload = workspace ? { repoKey: workspace } : { imageKey: 'opencode-v1' }
        const created = await mutate(
          () => api('/api/instances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }),
          showCreateError
        )
        if (created) createDialog.close()
      })
      createDialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault() })
      createDialog.addEventListener('close', () => {
        createForm.reset()
        createError.textContent = ''
        createError.classList.add('hidden')
      })
      document.querySelector('#delete-cancel').addEventListener('click', () => deleteDialog.close())
      deleteConfirm.addEventListener('click', () => {
        const target = deleting
        deleteDialog.close()
        if (target) mutate(() => api('/api/instances/' + encodeURIComponent(target.id), { method: 'DELETE' }))
      })
      deleteDialog.addEventListener('close', () => { deleting = null })

      refresh()
      setInterval(() => { if (!busy && !document.hidden) refresh(true) }, 5000)
    </script>
  </body>
</html>`;
