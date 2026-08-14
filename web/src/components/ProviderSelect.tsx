import { useMemo } from 'react';
import { isDockerProvider, type SessionProvider, type SessionProviderOption } from '../api';
import { PillSelect } from './PillSelect';

/**
 * How a host is named where the catalog is not at hand — a session page
 * showing the host its own session runs on, an instance modal.
 *
 * Docker hosts are the operator's, so their real names live in settings and
 * ride along with the catalog; all this can say without one is that the
 * session is on Docker. Falls back to the id, which is at least the operator's
 * own word for the box.
 */
export function providerLabel(provider: SessionProvider): string {
  if (provider === 'cloudflare') {
    return 'Cloudflare';
  }
  if (provider === 'docker') {
    return 'Docker';
  }
  return isDockerProvider(provider)
    ? `Docker · ${provider.slice('docker:'.length)}`
    : provider;
}

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
  providers: readonly SessionProviderOption[];
  value: SessionProvider;
  disabled?: boolean;
  onChange: (provider: SessionProvider) => void;
}) {
  const options = useMemo(
    () =>
      providers.map((option) => ({
        value: option.provider,
        label: option.label
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
