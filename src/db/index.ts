/**
 * The one place a Drizzle client is made.
 *
 * Every store module takes `env` and calls {@link db} rather than holding a
 * client, which keeps the modules exactly as testable as they were when they
 * called `env.DB.prepare` directly — hand in an `Env` with a D1 binding and
 * they work. Construction is cheap (Drizzle wraps the binding; it opens
 * nothing), so there is no connection to pool and nothing to cache across
 * requests.
 *
 * Every query still goes through the primary: the D1 Sessions API (read
 * replication) is deliberately unused, so a read is strongly consistent with
 * the writes that precede it.
 */
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema.ts';

export { schema };
export * from './schema.ts';

export function db(env: Env) {
  return drizzle(env.DB, { schema });
}
