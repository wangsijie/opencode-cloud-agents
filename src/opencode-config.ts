import type { Config } from '@opencode-ai/sdk/v2';

export const DEFAULT_PROVIDER_ID = 'vwnpc';
export const DEFAULT_MODEL_ID = 'ag/gemini-3.6-flash-high';

const DEFAULT_MODEL = `${DEFAULT_PROVIDER_ID}/${DEFAULT_MODEL_ID}`;

/** Canonical `providerID/modelID` reference used by session records. */
export const DEFAULT_MODEL_REF = DEFAULT_MODEL;

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
  /**
   * Nobody is at the keyboard, so every permission must be decided here.
   *
   * OpenCode's permission check falls through to `ask` for anything no rule
   * matches, and an ask parks the tool call on a promise that only a reply can
   * settle. The Hub has no permission UI and never answers, so a single ask
   * strands the session: the tool part stays `running`, the container stays
   * busy, and the only way out is aborting the conversation. `external_directory`
   * is the one that fires in practice — a model reading a file outside the
   * checkout, say OpenCode's own `node_modules` under `/root/.config` — and
   * `doom_loop` is the same trap for a model that keeps re-exploring.
   *
   * These are the sandbox's own files in a container that exists to run this
   * one conversation, so `allow` is what the operator would answer every time.
   * Keep every key here set: an omitted one is an `ask`, and an `ask` is a hang.
   * `task` is the subagent spawn, and it hangs the same way — the parent parks
   * on the tool call while the child session it would have started never exists.
   */
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    doom_loop: 'allow',
    external_directory: 'allow',
    task: 'allow'
  },
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
      npm: '@ai-sdk/openai-compatible',
      name: 'VWNPC',
      options: {
        apiKey: 'sk-15901412e7cb7127-bkmlv9-d635466a',
        baseURL: 'https://sub.vwnpc.com/v1'
      },
      models: {
        'gcli/grok-4.5': {
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
        'ag/gemini-3.6-flash-high': {
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
        'cx/gpt-5.6-sol': {
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
        'cx/gpt-5.6-terra': {
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
        'cx/gpt-5.6-luna': {
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

/**
 * One selectable model in the session composer.
 *
 * `id` is the `providerID/modelID` reference persisted on a session record.
 * Model ids themselves may contain slashes (`ag/gemini-3.6-flash-high`), so the
 * provider is always the first segment and the model is everything after it.
 *
 * `variants` are the OpenCode reasoning-effort knobs for that model. Empty means
 * the model has no selectable effort; the composer hides the control then.
 */
export interface ModelVariantOption {
  id: string;
  label: string;
}

export interface ModelOption {
  id: string;
  providerID: string;
  modelID: string;
  providerName: string;
  modelName: string;
  displayName: string;
  variants: readonly ModelVariantOption[];
}

function labelForVariant(id: string): string {
  if (id === 'xhigh') {
    return 'XHigh';
  }
  return id.length === 0 ? id : id[0].toUpperCase() + id.slice(1);
}

function variantsForModel(
  model: { variants?: Record<string, unknown> } | undefined
): readonly ModelVariantOption[] {
  return Object.keys(model?.variants ?? {}).map((id) => ({
    id,
    label: labelForVariant(id)
  }));
}

/**
 * Default effort when the model has variants and the client did not pick one.
 * Prefer medium, then high, then the first listed key — matching how the models
 * are configured (GPT family has medium; Kimi/Sakana start at high).
 */
export function defaultVariantForModel(modelRef: string): string | undefined {
  const variants = findModel(modelRef)?.variants ?? [];
  if (variants.length === 0) {
    return undefined;
  }
  return (
    variants.find((variant) => variant.id === 'medium')?.id ??
    variants.find((variant) => variant.id === 'high')?.id ??
    variants[0]?.id
  );
}

export const MODEL_OPTIONS: readonly ModelOption[] = Object.entries(
  OPENCODE_CONFIG.provider ?? {}
).flatMap(([providerID, provider]) => {
  const providerName = provider?.name ?? providerID;
  return Object.entries(provider?.models ?? {}).map(
    ([modelID, model]): ModelOption => {
      const modelName = model?.name ?? modelID;
      return {
        id: `${providerID}/${modelID}`,
        providerID,
        modelID,
        providerName,
        modelName,
        displayName: `${providerName} · ${modelName}`,
        variants: variantsForModel(model)
      };
    }
  );
});

export function findModel(modelRef: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((option) => option.id === modelRef);
}

export function isModelRef(value: unknown): value is string {
  return typeof value === 'string' && findModel(value) !== undefined;
}

/**
 * True when `variant` is a configured key for `modelRef`, or when both are
 * empty because the model has no variants.
 */
export function isValidVariant(
  modelRef: string,
  variant: unknown
): variant is string | undefined {
  const option = findModel(modelRef);
  if (!option) {
    return false;
  }
  if (variant === undefined || variant === null || variant === '') {
    return option.variants.length === 0;
  }
  return (
    typeof variant === 'string' &&
    option.variants.some((entry) => entry.id === variant)
  );
}

/**
 * Split a catalog reference into the provider/model pair the OpenCode API
 * expects. Unknown references are rejected instead of being forwarded, so a
 * stale UI cannot make the container start work with an unconfigured model.
 */
export function parseModelRef(
  modelRef: string
): { providerID: string; modelID: string } | undefined {
  const option = findModel(modelRef);
  return option
    ? { providerID: option.providerID, modelID: option.modelID }
    : undefined;
}

if (!isModelRef(DEFAULT_MODEL_REF)) {
  throw new Error(`Default model is missing from the catalog: ${DEFAULT_MODEL_REF}`);
}
