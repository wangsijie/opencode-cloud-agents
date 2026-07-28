import { useMemo } from 'react';
import type { SessionProvider } from '../api';
import { PillSelect } from './PillSelect';

/** How each host is named wherever a session shows the one it runs on. */
export const PROVIDER_LABELS: Record<SessionProvider, string> = {
  cloudflare: 'Cloudflare',
  docker: 'Docker'
};

/**
 * Which sandbox host a new session runs on.
 *
 * Hidden by the parent when the catalog lists one provider, which is the
 * ordinary deployment: a picker with a single option would only ask a question
 * that has no second answer. The choice is fixed at creation — a session cannot
 * move between hosts afterwards, because its workspace does not.
 */
export function ProviderSelect({
  providers,
  value,
  disabled,
  onChange
}: {
  providers: readonly SessionProvider[];
  value: SessionProvider;
  disabled?: boolean;
  onChange: (provider: SessionProvider) => void;
}) {
  const options = useMemo(
    () =>
      providers.map((provider) => ({
        value: provider,
        label: PROVIDER_LABELS[provider] ?? provider
      })),
    [providers]
  );

  return (
    <PillSelect
      options={options}
      value={value}
      ariaLabel="Sandbox host"
      placeholder="Sandbox"
      disabled={disabled}
      emptyLabel="No sandbox host available"
      onChange={(next) => onChange(next as SessionProvider)}
    />
  );
}
