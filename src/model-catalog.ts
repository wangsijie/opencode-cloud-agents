/**
 * The model catalog, derived from the stored OpenCode config.
 *
 * The config used to be a hardcoded module constant and the catalog a
 * module-load derivation; both now come from the `settings` table. Nothing
 * caches across requests on purpose: isolates cannot be told a setting
 * changed, and a stale catalog would keep validating against models the
 * operator just removed. A handler loads the catalog once at its top and
 * passes it down; a single-row read is cheap enough for that.
 *
 * `catalogFromConfig` stays pure so the derivation is unit-testable without a
 * database.
 */
import type { Config } from '@opencode-ai/sdk/v2';
import { HttpError } from './http.ts';
import { SETTING_KEYS, readSetting } from './settings.ts';

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

export interface ModelSelection {
  model: string;
  variant?: string;
}

export interface ModelCatalog {
  options: readonly ModelOption[];
  /** The config's `model`: the default `providerID/modelID` reference. */
  defaultModelRef: string;
  findModel(modelRef: string): ModelOption | undefined;
  isModelRef(value: unknown): value is string;
  /**
   * True when `variant` is a configured key for `modelRef`, or when both are
   * empty because the model has no variants.
   */
  isValidVariant(modelRef: string, variant: unknown): variant is string | undefined;
  /**
   * Split a catalog reference into the provider/model pair the OpenCode API
   * expects. Unknown references are rejected instead of being forwarded, so a
   * stale UI cannot make the container start work with an unconfigured model.
   */
  parseModelRef(
    modelRef: string
  ): { providerID: string; modelID: string } | undefined;
  /**
   * Default effort when the model has variants and the client did not pick
   * one. Prefer medium, then high, then the first listed key.
   */
  defaultVariantForModel(modelRef: string): string | undefined;
  /**
   * Pick a variant the model actually has. An explicit preference wins when
   * valid; otherwise the model default. Models without variants return
   * undefined.
   */
  resolveVariant(modelRef: string, preferred: string | undefined): string | undefined;
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

/** Derive the selectable catalog from a config's provider map. */
export function catalogFromConfig(config: Config): ModelCatalog {
  const options: readonly ModelOption[] = Object.entries(
    config.provider ?? {}
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

  const findModel = (modelRef: string): ModelOption | undefined =>
    options.find((option) => option.id === modelRef);

  const isModelRef = (value: unknown): value is string =>
    typeof value === 'string' && findModel(value) !== undefined;

  const isValidVariant = (
    modelRef: string,
    variant: unknown
  ): variant is string | undefined => {
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
  };

  const defaultVariantForModel = (modelRef: string): string | undefined => {
    const variants = findModel(modelRef)?.variants ?? [];
    if (variants.length === 0) {
      return undefined;
    }
    return (
      variants.find((variant) => variant.id === 'medium')?.id ??
      variants.find((variant) => variant.id === 'high')?.id ??
      variants[0]?.id
    );
  };

  return {
    options,
    defaultModelRef: config.model ?? '',
    findModel,
    isModelRef,
    isValidVariant,
    parseModelRef: (modelRef) => {
      const option = findModel(modelRef);
      return option
        ? { providerID: option.providerID, modelID: option.modelID }
        : undefined;
    },
    defaultVariantForModel,
    resolveVariant: (modelRef, preferred) => {
      if (preferred !== undefined && isValidVariant(modelRef, preferred)) {
        return preferred;
      }
      return defaultVariantForModel(modelRef);
    }
  };
}

/**
 * Pick the model and effort the new-session composer should start with.
 *
 * Session rows are the durable record of the last selection. A forced config
 * change can remove that model or one of its variants, so every remembered
 * value is resolved against the current catalog before it reaches the browser.
 */
export function resolveDefaultModelSelection(
  catalog: ModelCatalog,
  recent?: ModelSelection
): ModelSelection {
  const model = catalog.isModelRef(recent?.model)
    ? recent.model
    : catalog.isModelRef(catalog.defaultModelRef)
      ? catalog.defaultModelRef
      : (catalog.options[0]?.id ?? '');
  const variant = catalog.resolveVariant(
    model,
    recent?.model === model ? recent.variant : undefined
  );
  return { model, ...(variant ? { variant } : {}) };
}

/**
 * The stored OpenCode config, whole. 409 rather than 500 when it is missing:
 * the deployment works, it just has not been configured yet, and the settings
 * page is where the caller should be sent.
 */
export async function loadOpencodeConfig(env: Env): Promise<Config> {
  const config = await readSetting<Config>(env, SETTING_KEYS.opencodeConfig);
  if (!config) {
    throw new HttpError(
      409,
      'OpenCode is not configured yet; set the config on the settings page'
    );
  }
  return config;
}

export async function loadModelCatalog(env: Env): Promise<ModelCatalog> {
  return catalogFromConfig(await loadOpencodeConfig(env));
}
