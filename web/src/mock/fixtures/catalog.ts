/** Repository and model options for the composer pickers. */
import type { Catalog } from '../../api';
import { daysAgo } from './util';

export function buildCatalog(): Catalog {
  return {
    repos: [
      { repoKey: 'wangsijie/opencode-cloud', displayName: 'opencode-cloud' },
      { repoKey: 'wangsijie/logto', displayName: 'logto' },
      {
        repoKey: 'silverhand-io/experimental-payment-reconciliation-service',
        displayName: 'experimental-payment-reconciliation-service'
      },
      { repoKey: 'wangsijie/知识库', displayName: '知识库 · 团队文档' }
    ],
    models: [
      {
        id: 'anthropic/claude-opus-4-5',
        displayName: 'anthropic · Claude Opus 4.5',
        modelName: 'Claude Opus 4.5',
        variants: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' }
        ]
      },
      {
        // No variants: the effort picker stays hidden for this one.
        id: 'anthropic/claude-sonnet-4-5',
        displayName: 'anthropic · Claude Sonnet 4.5',
        modelName: 'Claude Sonnet 4.5'
      },
      {
        id: 'openai/gpt-5.2-codex',
        displayName: 'openai · GPT-5.2 Codex',
        modelName: 'GPT-5.2 Codex',
        variants: [
          { id: 'medium', label: 'Medium' },
          { id: 'xhigh', label: 'Extra high' }
        ]
      },
      {
        id: 'google/gemini-3-pro-preview-2026-07-super-long-identifier',
        displayName: 'google · Gemini 3 Pro Preview (extremely long model name for truncation testing)',
        modelName: 'Gemini 3 Pro Preview (extremely long model name for truncation testing)'
      }
    ],
    // Both hosts, so the composer's provider picker is visible in the mock. A
    // real deployment lists Docker only once its agent is configured.
    providers: ['cloudflare', 'docker'],
    defaultSelection: {
      model: 'anthropic/claude-opus-4-5',
      variant: 'medium'
    },
    // Stale on the first read: the Hub page performs its one-shot refresh,
    // which the mock answers with a fresh timestamp.
    reposFetchedAt: daysAgo(3),
    reposStale: true
  };
}
