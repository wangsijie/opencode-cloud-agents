import type { Catalog } from './api';
import type { Route } from './router';

export function enteredNewSessionPage(
  previous: Route['name'],
  current: Route['name']
): boolean {
  return current === 'list' && previous !== 'list';
}

/**
 * The catalog the new-session composer should render on a route transition.
 *
 * Entering the list page hides the catalog until the fresh read lands: the
 * composer applies its defaults the moment it sees one, so mounting it with
 * the previous visit's order would treat that order's default as a deliberate
 * pick — and the fresh answer, which only replaces an *invalid* choice, could
 * never override it. The refresh effect runs after the render, so the hiding
 * has to be decided here, while `previous` still names the route the browser
 * came from.
 */
export function catalogForRoute(
  current: Route['name'],
  previous: Route['name'],
  catalog: Catalog | undefined
): Catalog | undefined {
  return enteredNewSessionPage(previous, current) ? undefined : catalog;
}

