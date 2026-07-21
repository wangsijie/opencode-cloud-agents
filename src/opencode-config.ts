import type { Config } from '@opencode-ai/sdk/v2';

export const DEFAULT_PROVIDER_ID = 'vwnpc';
export const DEFAULT_MODEL_ID = 'grok-4.5';

const DEFAULT_MODEL = `${DEFAULT_PROVIDER_ID}/${DEFAULT_MODEL_ID}`;

/**
 * Complete OpenCode configuration shared by the web UI and SDK client.
 *
 * This private repository intentionally keeps provider credentials alongside
 * the rest of the provider definition so adding or changing providers is a
 * single-file operation.
 */
export const OPENCODE_CONFIG: Config = {
  model: DEFAULT_MODEL,
  small_model: DEFAULT_MODEL,
  mcp: {
    linear: {
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      enabled: true
    },
    notion: {
      type: 'remote',
      url: 'https://mcp.notion.com/mcp',
      enabled: true
    }
  },
  provider: {
    [DEFAULT_PROVIDER_ID]: {
      npm: '@ai-sdk/anthropic',
      name: 'VW NPC (Grok)',
      options: {
        apiKey: "sk-1XSC7d5LAkDdYeWUn",
        baseURL: 'https://ai.vwnpc.com/v1'
      },
      models: {
        [DEFAULT_MODEL_ID]: {
          name: 'Grok 4.5',
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 500000,
            output: 65536
          }
        }
      }
    }
  }
};
