import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createSession,
  type Catalog,
  type SessionProvider,
  type SessionView
} from '../api';
import { navigate, sessionPath } from '../router';
import {
  AttachButton,
  AttachmentChips,
  toAttachmentPayload,
  useComposerAttachments
} from './ComposerAttachments';
import { ArrowUpIcon, MenuIcon, SparkIcon } from './icons';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';
import { NO_REPO, RepoSelect } from './RepoSelect';
import { defaultVariant, VariantSelect } from './VariantSelect';

/**
 * Where a session starts: a repository, a model and a prompt.
 *
 * The repository is optional. Picking "No repository" starts a session that
 * clones nothing and works in `/workspace` itself — a scratch container, with
 * no diff and nothing to push.
 *
 * Creating returns as soon as the Hub has accepted the work — the container
 * wake, the repository clone and the first dispatch all happen afterwards — so
 * this hands over to the conversation immediately and lets that page show the
 * cold start as progress.
 *
 * The catalog arrives from GitHub a moment after the page does, so the form
 * renders without it and the pickers say they are loading. Waiting would make
 * the whole page pop in late, which reads as broken.
 */
export function NewSessionPage({
  catalog,
  catalogError,
  onRefreshRepos,
  onCreated,
  onMenu
}: {
  catalog?: Catalog;
  catalogError?: string;
  onRefreshRepos: () => Promise<void>;
  /** Receives the created view so the sidebar can show it before the poll. */
  onCreated: (created: SessionView) => void;
  onMenu: () => void;
}) {
  // `undefined` is "not chosen yet", which the catalog effect below resolves to
  // the last-used repository; `NO_REPO` is a deliberate choice and sticks.
  const [repoKey, setRepoKey] = useState<string>();
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const [prompt, setPrompt] = useState('');
  // Resolved from the catalog's preference order once it lands — docker first
  // when configured, otherwise cloudflare. undefined until then so a hard-coded
  // cloudflare does not stick past a catalog that prefers docker.
  const [provider, setProvider] = useState<SessionProvider>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const attachmentsApi = useComposerAttachments(setError);

  const repos = catalog?.repos;
  const selectedModel = useMemo(
    () => catalog?.models.find((option) => option.id === model),
    [catalog?.models, model]
  );
  const modelVariants = selectedModel?.variants ?? [];

  // The catalog lands after the first paint, and a refresh can drop the
  // selected repository, so the defaults are applied here rather than in
  // useState. The Hub sorts by last use, so the first entry is the repository
  // the last session ran in. Having chosen no repository is a selection like
  // any other, so it survives both.
  useEffect(() => {
    if (!repos) {
      return;
    }
    setRepoKey((current) =>
      current === NO_REPO || repos.some((repo) => repo.repoKey === current)
        ? current
        : (repos[0]?.repoKey ?? NO_REPO)
    );
  }, [repos]);

  // A provider can leave the catalog under an open tab — clearing the Docker
  // settings is all it takes — and starting a session on one the Hub would
  // refuse is a 400 in place of a session. First paint takes providers[0]
  // (preference order); a deliberate pick sticks until it leaves the list.
  const providers = catalog?.providers;
  useEffect(() => {
    if (!providers || providers.length === 0) {
      return;
    }
    setProvider((current) =>
      current && providers.includes(current)
        ? current
        : (providers[0] ?? 'cloudflare')
    );
  }, [providers]);

  useEffect(() => {
    const models = catalog?.models;
    if (!models || models.length === 0) {
      return;
    }
    setModel((current) =>
      models.some((option) => option.id === current)
        ? current
        : catalog.defaultSelection.model
    );
  }, [catalog]);

  // Reset effort when the model changes, or when the current choice is no
  // longer listed for that model.
  useEffect(() => {
    const variants =
      catalog?.models.find((option) => option.id === model)?.variants ?? [];
    const remembered =
      model === catalog?.defaultSelection.model
        ? catalog.defaultSelection.variant
        : undefined;
    const next = variants.some((entry) => entry.id === remembered)
      ? remembered
      : defaultVariant(variants);
    setVariant((current) =>
      next && variants.some((entry) => entry.id === current) ? current : (next ?? '')
    );
  }, [catalog, model]);

  const loading = !catalog;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy || attachmentsApi.reading) {
      setError(text ? undefined : 'Describe what you want done first');
      return;
    }
    setBusy(true);
    setError(undefined);
    const attachments = attachmentsApi.attachments;
    try {
      const created = await createSession({
        ...(repoKey ? { repoKey } : {}),
        model,
        ...(variant ? { variant } : {}),
        prompt: text,
        provider: provider ?? providers?.[0] ?? 'cloudflare',
        ...(attachments.length > 0
          ? { attachments: toAttachmentPayload(attachments) }
          : {})
      });
      setPrompt('');
      attachmentsApi.clear();
      onCreated(created);
      navigate(sessionPath(created.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="session-view">
      {/* Nothing but the drawer button lives here, so it carries no rule: an
          empty bordered strip above an otherwise empty page reads as a bug. */}
      <header className="content-header bare">
        <button
          className="icon-button hamburger"
          type="button"
          onClick={onMenu}
          aria-label="Open sessions"
        >
          <MenuIcon />
        </button>
      </header>

      <div className="content-body">
        <div className="new-session">
          <h1 className="greeting">
            <SparkIcon />
            What should we build?
          </h1>

          {/*
            Only a failure that leaves nothing to pick from replaces the
            composer: with a list in hand — stored by the Hub from an earlier
            visit — a failed refresh changes nothing about what can be started.
          */}
          {catalogError && !catalog ? (
            <section className="card error">
              <h2>Could not load the repository list</h2>
              <p className="muted">{catalogError}</p>
              <div className="actions">
                <button
                  className="button"
                  onClick={() => void onRefreshRepos().catch(() => undefined)}
                >
                  Retry
                </button>
              </div>
            </section>
          ) : (
            <form className="composer-box" onSubmit={submit} aria-busy={busy || loading}>
              <AttachmentChips api={attachmentsApi} />
              <textarea
                className="prompt"
                rows={3}
                placeholder="What should we do this time?"
                value={prompt}
                disabled={busy}
                autoFocus={matchMedia('(min-width: 768px)').matches}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={attachmentsApi.onPaste}
                onKeyDown={(event) => {
                  // Enter starts the session, Shift+Enter breaks the line — but
                  // not while an input method is mid-composition, where Enter is
                  // how you accept the candidate you are typing.
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submit(event);
                  }
                }}
              />
              <div className="composer-row">
                <AttachButton api={attachmentsApi} disabled={busy} />
                <RepoSelect
                  repos={catalog?.repos}
                  value={repoKey ?? NO_REPO}
                  loading={loading}
                  disabled={busy}
                  onChange={setRepoKey}
                  onRefresh={onRefreshRepos}
                />
                <ModelSelect
                  models={catalog?.models}
                  value={model}
                  loading={loading}
                  disabled={busy}
                  onChange={setModel}
                />
                {modelVariants.length > 0 ? (
                  <VariantSelect
                    variants={modelVariants}
                    value={variant}
                    disabled={busy}
                    onChange={setVariant}
                  />
                ) : null}
                {providers && providers.length > 1 && provider ? (
                  <ProviderSelect
                    providers={providers}
                    value={provider}
                    disabled={busy}
                    onChange={setProvider}
                  />
                ) : null}
                <span className="spacer" />
                <button
                  className="send-button"
                  type="submit"
                  disabled={
                    busy || loading || !prompt.trim() || attachmentsApi.reading
                  }
                  aria-label="Start session"
                >
                  <ArrowUpIcon />
                </button>
              </div>
              {error ? <p className="form-error">{error}</p> : null}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
