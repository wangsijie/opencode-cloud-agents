import { useMemo } from 'react';
import type { ModelVariantOption } from '../api';
import { PillSelect } from './PillSelect';

/**
 * Reasoning-effort picker for models that expose OpenCode variants.
 *
 * Hidden by the parent when the selected model has no variants — a control that
 * does nothing would only look like a bug.
 */
export function VariantSelect({
  variants,
  value,
  disabled,
  onChange
}: {
  variants: readonly ModelVariantOption[];
  value: string;
  disabled?: boolean;
  onChange: (variant: string) => void;
}) {
  const options = useMemo(
    () =>
      variants.map((variant) => ({
        value: variant.id,
        label: variant.label
      })),
    [variants]
  );

  return (
    <PillSelect
      options={options}
      value={value}
      ariaLabel="Thinking effort"
      placeholder="Effort"
      disabled={disabled}
      emptyLabel="No effort available"
      onChange={onChange}
    />
  );
}

/** Prefer medium, then high, then the first listed key. */
export function defaultVariant(
  variants: readonly ModelVariantOption[] | undefined
): string | undefined {
  if (!variants || variants.length === 0) {
    return undefined;
  }
  return (
    variants.find((variant) => variant.id === 'medium')?.id ??
    variants.find((variant) => variant.id === 'high')?.id ??
    variants[0]?.id
  );
}
