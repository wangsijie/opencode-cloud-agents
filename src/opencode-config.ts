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
          },
          cost: {
            input: 2,
            output: 6,
            cache_read: 0.5,
            context_over_200k: {
              input: 4,
              output: 12,
              cache_read: 1
            }
          }
        },
        'gemini-3.6-flash-high': {
          name: 'Gemini 3.6 Flash High',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 1048576,
            output: 65536
          }
        },
        'gpt-5.6-sol': {
          name: 'GPT-5.6 Sol',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 372000,
            output: 128000
          },
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            context_over_200k: {
              input: 10,
              output: 45,
              cache_read: 1
            }
          },
          variants: {
            none: { reasoningEffort: 'none' },
            low: { reasoningEffort: 'low' },
            medium: { reasoningEffort: 'medium' },
            high: { reasoningEffort: 'high' },
            xhigh: { reasoningEffort: 'xhigh' }
          }
        },
        'gpt-5.6-terra': {
          name: 'GPT-5.6 Terra',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 372000,
            output: 128000
          },
          cost: {
            input: 2.5,
            output: 15,
            cache_read: 0.25,
            context_over_200k: {
              input: 5,
              output: 22.5,
              cache_read: 0.5
            }
          },
          variants: {
            none: { reasoningEffort: 'none' },
            low: { reasoningEffort: 'low' },
            medium: { reasoningEffort: 'medium' },
            high: { reasoningEffort: 'high' },
            xhigh: { reasoningEffort: 'xhigh' }
          }
        },
        'gpt-5.6-luna': {
          name: 'GPT-5.6 Luna',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 372000,
            output: 128000
          },
          cost: {
            input: 1,
            output: 6,
            cache_read: 0.1,
            context_over_200k: {
              input: 2,
              output: 9,
              cache_read: 0.2
            }
          },
          variants: {
            none: { reasoningEffort: 'none' },
            low: { reasoningEffort: 'low' },
            medium: { reasoningEffort: 'medium' },
            high: { reasoningEffort: 'high' },
            xhigh: { reasoningEffort: 'xhigh' }
          }
        }
      }
    },
    'kimi-code': {
      npm: '@ai-sdk/openai-compatible',
      name: 'Kimi Coding Plan',
      options: {
        baseURL: 'https://api.kimi.com/coding/v1'
      },
      models: {
        k3: {
          name: 'Kimi K3',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 262144,
            output: 65536
          },
          variants: {
            low: { reasoningEffort: 'low' },
            high: { reasoningEffort: 'high' },
            max: { reasoningEffort: 'max' }
          }
        },
        'kimi-for-coding': {
          name: 'Kimi K2.7 Code',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 262144,
            output: 65536
          }
        },
        'kimi-for-coding-highspeed': {
          name: 'Kimi K2.7 Code Highspeed',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 262144,
            output: 65536
          }
        }
      }
    },
    sakana: {
      name: 'Sakana AI',
      options: {
        baseURL: 'https://api.sakana.ai/v1',
        apiKey: 'fish_196b01b87f0efec664965514ceb931eee51334dca8393815471d5a3d703b6862'
      },
      whitelist: ['fugu', 'fugu-ultra'],
      models: {
        fugu: {
          name: 'Fugu',
          family: 'fugu',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 1000000,
            output: 1000000
          },
          variants: {
            high: { reasoningEffort: 'high' },
            xhigh: { reasoningEffort: 'xhigh' }
          }
        },
        'fugu-ultra': {
          name: 'Fugu Ultra',
          family: 'fugu-ultra',
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text']
          },
          limit: {
            context: 1000000,
            output: 1000000
          },
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            context_over_200k: {
              input: 10,
              output: 45,
              cache_read: 1
            }
          },
          variants: {
            high: { reasoningEffort: 'high' },
            xhigh: { reasoningEffort: 'xhigh' }
          }
        }
      }
    }
  }
};
