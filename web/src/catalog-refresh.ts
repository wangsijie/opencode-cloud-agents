import type { Route } from './router';

export function enteredNewSessionPage(
  previous: Route['name'],
  current: Route['name']
): boolean {
  return current === 'list' && previous !== 'list';
}
