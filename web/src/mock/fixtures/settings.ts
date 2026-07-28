/**
 * SettingView fixtures — all seven descriptors from the Worker's
 * `src/settings-schema.ts`, mixing configured and unset states. Exposure rules
 * are mirrored: secrets carry no value, partial settings carry the public half.
 */
import type { SettingView } from '../../api';
import { daysAgo, hoursAgo } from './util';

export const MOCK_SSH_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMockMOck hub@mock';

/** A config that satisfies the server's permission-completeness gate. */
export const MOCK_OPENCODE_CONFIG = {
  model: 'anthropic/claude-opus-4-5',
  small_model: 'anthropic/claude-sonnet-4-5',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    doom_loop: 'allow',
    external_directory: 'allow',
    task: 'allow'
  },
  provider: {
    anthropic: {
      npm: '@ai-sdk/anthropic',
      name: 'Anthropic',
      options: { apiKey: 'sk-ant-mock' },
      models: {
        'claude-opus-4-5': { name: 'Claude Opus 4.5' },
        'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5' }
      }
    }
  }
};

export function buildSettings(): SettingView[] {
  return [
    {
      key: 'github.token',
      group: 'github',
      label: 'GitHub token',
      required: true,
      configured: true,
      updatedAt: daysAgo(12)
      // Secret exposure: no value, ever.
    },
    {
      key: 'opencode.config',
      group: 'opencode',
      label: 'OpenCode config',
      required: true,
      configured: true,
      updatedAt: daysAgo(2),
      value: MOCK_OPENCODE_CONFIG
    },
    {
      key: 'container.ssh-key',
      group: 'container',
      label: 'SSH key',
      required: true,
      configured: true,
      updatedAt: daysAgo(12),
      value: { publicKey: MOCK_SSH_PUBLIC_KEY }
    },
    {
      key: 'container.env',
      group: 'container',
      label: 'Environment variables',
      required: false,
      configured: true,
      updatedAt: hoursAgo(20),
      // Partial exposure: names only, values stay write-only.
      value: [{ name: 'NPM_TOKEN' }, { name: 'SENTRY_DSN' }]
    },
    {
      key: 'opencode.skills',
      group: 'opencode',
      label: 'Skills',
      required: false,
      configured: true,
      updatedAt: daysAgo(3),
      value: [
        {
          name: 'babysit',
          content:
            '---\nname: babysit\ndescription: Watch a PR until CI passes.\n---\n\nRe-check the PR every few minutes until CI is green.'
        },
        {
          name: 'deploy-preview',
          repoKey: 'wangsijie/logto',
          content:
            '---\nname: deploy-preview\ndescription: Deploy a preview environment.\n---\n\nRun `pnpm deploy:preview` and post the URL.'
        }
      ]
    },
    {
      key: 'opencode.agents-md',
      group: 'opencode',
      label: 'AGENTS.md',
      required: false,
      configured: true,
      updatedAt: daysAgo(1),
      value: {
        global: '# House rules\n\nAlways run the linter before committing.',
        repos: [
          {
            repoKey: 'wangsijie/logto',
            content: 'Use pnpm, and never touch the generated SDK folders.'
          }
        ]
      }
    },
    {
      key: 'git.identity',
      group: 'git',
      label: 'Git identity',
      required: false,
      configured: true,
      updatedAt: daysAgo(5),
      value: {
        name: 'Sijie Wang',
        email: 'wangsijie@silverhand.io',
        overrides: [
          { owner: 'silverhand-io', name: 'Sijie @ Silverhand', email: 'sijie@silverhand.io' }
        ]
      }
    }
  ];
}
