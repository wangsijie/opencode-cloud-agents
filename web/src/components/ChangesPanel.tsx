import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  fetchChanges,
  publishChanges,
  type PublishResult,
  type SessionChanges
} from '../api';

const STATUS_LABELS: Record<string, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突'
};

/**
 * What the agent changed, and the way out of the container.
 *
 * This is the panel that makes a session's output reviewable without leaving
 * the conversation: the file list and diff come from git in the checkout, and
 * publishing commits, pushes and (optionally) opens a pull request in one step.
 *
 * It loads on demand rather than with the page. Reading a diff runs commands in
 * the container, so paying for it on every session view — and on every poll —
 * would make looking at a conversation more expensive than having one.
 */
export function ChangesPanel({
  sessionId,
  attached,
  sessionTitle
}: {
  sessionId: string;
  attached: boolean;
  sessionTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<SessionChanges>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [withPullRequest, setWithPullRequest] = useState(true);
  const [published, setPublished] = useState<PublishResult>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setChanges(await fetchChanges(sessionId));
    } catch (cause) {
      setChanges(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Opening is the request to read; a sleeping container has nothing to read
  // and must not be woken by a panel being expanded.
  useEffect(() => {
    if (open && attached && !changes && !loading) {
      void load();
    }
  }, [open, attached, changes, loading, load]);

  async function publish(event: FormEvent) {
    event.preventDefault();
    const commitMessage = message.trim() || sessionTitle;
    if (!commitMessage || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await publishChanges(sessionId, {
        message: commitMessage,
        ...(withPullRequest
          ? {
              pullRequest: {
                title: commitMessage.split('\n')[0],
                body: `由 OpenCode Cloud 会话 ${sessionId} 生成。`
              }
            }
          : {})
      });
      setPublished(result);
      setMessage('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const dirty = (changes?.files.length ?? 0) > 0;
  const canPublish = dirty || (changes?.unpushedCommits ?? 0) > 0;

  return (
    <section className="card changes-panel">
      <header className="changes-header">
        <button
          className="link-button"
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} 代码改动
        </button>
        {open && attached ? (
          <button
            className="link-button"
            type="button"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            刷新
          </button>
        ) : null}
      </header>

      {!open ? null : !attached ? (
        <p className="muted">会话已休眠。发条消息唤醒容器后即可查看改动。</p>
      ) : loading && !changes ? (
        <p className="muted">正在读取工作区…</p>
      ) : (
        <>
          {changes ? (
            <>
              <p className="muted mono">
                {changes.branch}
                {changes.onDefaultBranch ? '（默认分支）' : ''} ·{' '}
                {changes.files.length} 个文件
                {changes.unpushedCommits > 0
                  ? ` · ${changes.unpushedCommits} 个未推送提交`
                  : ''}
              </p>
              {changes.files.length > 0 ? (
                <ul className="changed-files">
                  {changes.files.map((file) => (
                    <li key={file.path}>
                      <span className={`file-status status-${file.status}`}>
                        {STATUS_LABELS[file.status] ?? file.status}
                      </span>
                      <span className="mono">
                        {file.renamedFrom ? `${file.renamedFrom} → ` : ''}
                        {file.path}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">工作区干净，没有未提交的改动。</p>
              )}
              {changes.diff ? (
                <details className="diff-view">
                  <summary>查看 diff</summary>
                  <pre className="diff mono">{changes.diff}</pre>
                  {changes.diffTruncated ? (
                    <p className="muted">
                      diff 过长，已截断；完整内容可在工作区终端里 git diff 查看。
                    </p>
                  ) : null}
                </details>
              ) : null}
              {/*
                Untracked files have no diff against HEAD, and showing one would
                mean staging them during a read. Saying so beats a file list the
                diff silently disagrees with.
              */}
              {changes.files.some((file) => file.status === 'untracked') ? (
                <p className="muted">新增（未跟踪）文件不出现在 diff 里，但会被一起提交。</p>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="banner error" role="alert">
              {error}
            </p>
          ) : null}

          {published ? (
            <p className="banner">
              已推送到 <span className="mono">{published.branch}</span>
              {published.nothingToCommit ? '（工作区本就干净，推送了此前的提交）' : ''}
              {published.pullRequestUrl ? (
                <>
                  {' · '}
                  <a href={published.pullRequestUrl} target="_blank" rel="noreferrer">
                    查看 PR ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : null}

          {changes ? (
            <form className="publish-form" onSubmit={publish} aria-busy={busy}>
              <textarea
                className="prompt"
                rows={2}
                placeholder={`提交信息（默认用会话标题）`}
                value={message}
                disabled={busy || !canPublish}
                onChange={(event) => setMessage(event.target.value)}
              />
              <div className="composer-controls">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={withPullRequest}
                    disabled={busy || !canPublish}
                    onChange={(event) => setWithPullRequest(event.target.checked)}
                  />
                  同时建 PR
                </label>
                <button
                  className="button primary"
                  type="submit"
                  disabled={busy || !canPublish}
                >
                  提交并推送到 {changes.publishBranch}
                </button>
              </div>
              {changes.onDefaultBranch ? (
                <p className="muted">
                  改动会先切到 <span className="mono">{changes.publishBranch}</span>
                  ，不会直接提交到 {changes.defaultBranch}。
                </p>
              ) : null}
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
