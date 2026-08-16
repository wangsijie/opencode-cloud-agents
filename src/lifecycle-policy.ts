/**
 * The parts of the lifecycle policy that are decisions rather than plumbing.
 *
 * `lifecycle.ts` is a Durable Object, so it imports `cloudflare:workers` and
 * cannot be loaded by a test. Anything here is a pure function of state and a
 * clock, which is what makes the one rule that stops a container without being
 * asked to testable.
 */

/**
 * How long a container may stay unreachable before the policy stops it.
 *
 * Every probe failure is deliberately fail-open — an unreachable OpenCode is
 * not evidence that its work finished, so the idle window is cleared and the
 * container is left alone. Without a bound that is not caution, it is a leak:
 * `error_running` re-arms its own alarm forever, and the daily sweep only
 * claimed sessions whose cached lifecycle was `idle` or `sleeping`, so nothing
 * else ever reclaimed one.
 *
 * Three Mac mini containers ran for twelve days that way. A Docker restart
 * brought them back through `--restart unless-stopped`, but OpenCode is started
 * by a `docker exec` and is not PID 1's child, so it did not come back with
 * them: `sleep infinity` with nothing listening on 4096, probed every sixty
 * seconds, forever.
 *
 * An hour is far longer than any restart, redeploy or network partition this
 * has to survive, and the stop it triggers is the same checkpoint-and-stop a
 * manual one performs — the workspace is on a volume or in a snapshot, so a
 * session recovers by waking again.
 */
export const MAX_PROBE_FAILURE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The state this decision reads, named structurally so the Durable Object's
 * own stored state satisfies it without being exported.
 */
export interface ProbeFailureWindow {
  phase: string;
  probeFailingSince?: number;
}

/**
 * Has the policy been unable to reach this container for longer than it allows?
 *
 * Only `error_running` counts. The other phases either have a live probe
 * behind them or are already on their way down, and a stale `probeFailingSince`
 * left on one of those must not stop a container that has since answered.
 */
export function probeFailureWindowExpired(
  state: ProbeFailureWindow,
  now: number,
  windowMs: number = MAX_PROBE_FAILURE_WINDOW_MS
): boolean {
  return (
    state.phase === 'error_running' &&
    state.probeFailingSince !== undefined &&
    now - state.probeFailingSince >= windowMs
  );
}
