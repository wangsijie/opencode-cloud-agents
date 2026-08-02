import { useSyncExternalStore } from 'react';

/**
 * Whether the OS asks for a dark interface, live.
 *
 * The app itself never needs to know — its colors are CSS variables flipped by
 * a media query — but the diff viewer takes its theme as a prop, so someone has
 * to say the word. Subscribing keeps an open panel honest when the appearance
 * changes underneath it.
 */
const query = window.matchMedia('(prefers-color-scheme: dark)');

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

export const usePrefersDark = () =>
  useSyncExternalStore(subscribe, () => query.matches);
