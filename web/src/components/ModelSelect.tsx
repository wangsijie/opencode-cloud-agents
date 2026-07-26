import { useMemo } from 'react';
import type { ModelOption } from '../api';
import { PillSelect } from './PillSelect';

/**
 * The model picker.
 *
 * Only the model's own name is shown: the provider half of `displayName` is the
 * gateway account the request is billed through, which says nothing about what
 * you are picking and crowds a pill that has to fit a phone. It stays in the
 * search text so a provider name still finds its models.
 */
export function ModelSelect({
  models,
  value,
  disabled,
  loading,
  onChange
}: {
  models?: ModelOption[];
  value: string;
  disabled?: boolean;
  loading?: boolean;
  onChange: (model: string) => void;
}) {
  const options = useMemo(
    () =>
      models?.map((model) => ({
        value: model.id,
        label: model.modelName,
        keywords: model.displayName
      })),
    [models]
  );

  return (
    <PillSelect
      options={options}
      value={value}
      ariaLabel="Model"
      placeholder="Model"
      loadingLabel="Loading models…"
      disabled={disabled}
      loading={loading}
      emptyLabel="No model available"
      onChange={onChange}
    />
  );
}
