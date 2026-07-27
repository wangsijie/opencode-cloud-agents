/**
 * Where a subagent session sits under the session that started it.
 *
 * OpenCode's `task` tool runs its work in a *child* session: a real session in
 * the same container and the same checkout, linked to its parent by `parentID`
 * and never registered with the Hub. The Hub's own registry is one record per
 * container, so a child is only ever addressable as a pair — the Hub session
 * that owns the container, plus the OpenCode session id inside it.
 *
 * That pairing needs a check, and this is it. Walking `parentID` upwards from
 * the requested child until the container's root session appears answers two
 * questions at once: whether the id belongs to this session at all, and what
 * to put in the breadcrumb above the transcript. A walk that runs out of
 * parents, revisits a session, or exceeds the depth cap answers neither, and
 * the caller turns that into a 404 rather than showing a stranger's history.
 *
 * The walk is written against a reader callback rather than the SDK, because
 * the interesting cases — an orphan, a cycle, a chain that never terminates —
 * are the ones no live container will produce on demand.
 */

/** One session on the path from the container's root down to the subagent. */
export interface AgentSessionEntry {
  id: string;
  title: string;
  /** Which subagent OpenCode ran here. Absent on the root session. */
  agent?: string;
  parentID?: string;
}

export interface AgentSessionLineage {
  /** Root first, requested session last. Never empty when it is returned. */
  lineage: AgentSessionEntry[];
}

/**
 * How deep a chain of subagents may go before the walk gives up.
 *
 * A subagent can start its own subagent, so the depth is genuinely open-ended;
 * this is the point past which a chain is more likely to be a loop in the data
 * than a conversation anybody wants to read.
 */
export const MAX_LINEAGE_DEPTH = 10;

/**
 * Walk from `sessionId` up to `rootId`, or report that it does not get there.
 *
 * `read` answers with the session's own record, or `undefined` when OpenCode
 * does not know it. Returns the path root-first; `undefined` means the id is
 * not part of this container's session tree, which is the only answer the
 * caller is allowed to act on.
 */
export async function walkSessionLineage(
  sessionId: string,
  rootId: string,
  read: (id: string) => Promise<AgentSessionEntry | undefined>
): Promise<AgentSessionEntry[] | undefined> {
  const chain: AgentSessionEntry[] = [];
  const seen = new Set<string>();
  let current = sessionId;

  for (let hop = 0; hop <= MAX_LINEAGE_DEPTH; hop += 1) {
    // A cycle would otherwise be walked until the depth cap, and reaching the
    // cap is indistinguishable from a chain that is merely long.
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    const entry = await read(current);
    if (!entry) {
      return undefined;
    }
    chain.unshift(entry);
    if (entry.id === rootId) {
      return chain;
    }
    if (!entry.parentID) {
      // A root session that is not *this* container's root. Nothing links it
      // to the requested Hub session, so it is not readable through it.
      return undefined;
    }
    current = entry.parentID;
  }

  return undefined;
}

/**
 * Shape check for an OpenCode session id arriving from the browser.
 *
 * The id names a session inside one container, so this is not an authorization
 * boundary — `requireSession` already decided which container the request may
 * reach, and every session in it belongs to that one conversation. What this
 * prevents is a malformed id being pasted into a container URL.
 */
export function isSafeOpencodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
