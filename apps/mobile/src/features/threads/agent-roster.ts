import type { TranscriptItem } from "../conversation/lib/transcript-model";

/**
 * The agents the Agents pill and sheet list (T3 Code #20785): every agent of
 * the newest turn, as before, and an agent of an earlier turn while it still
 * works or waits. A new prompt no longer hides an agent that is still running.
 *
 * As the desktop rail (`rail-agents.ts`), a Solus session this conversation
 * messaged in several turns is one row: its newest card says where it stands.
 * A provider subagent is its own tool call, so it is always one row.
 */

/** The agent items of the loaded transcript, in order. */
export interface AgentCandidates {
  readonly ids: readonly string[];
  /** The ones after the newest prompt the person sent. */
  readonly newestTurn: ReadonlySet<string>;
  /** The other Solus session of each agent card; provider subagents have none. */
  readonly sessionOf: ReadonlyMap<string, string>;
}

/**
 * One pass over the order. It runs when a row is added or removed, not when
 * an item streams; the item states are read through per-item subscriptions.
 */
export function agentCandidates(
  store: { item(id: string): TranscriptItem | undefined },
  order: readonly string[],
): AgentCandidates {
  const ids: string[] = [];
  const sessionOf = new Map<string, string>();
  let newestTurnStart = 0;
  for (const id of order) {
    const item = store.item(id);
    if (item?.kind === "user") newestTurnStart = ids.length;
    else if (item?.kind === "agent") {
      ids.push(item.id);
      sessionOf.set(item.id, item.sessionId);
    } else if (item?.kind === "tool" && item.subagent) ids.push(item.id);
  }
  return { ids, newestTurn: new Set(ids.slice(newestTurnStart)), sessionOf };
}

/** The rows to list, in transcript order; `rows` are the candidates' presentations. */
export function agentRoster<Row extends { readonly id: string; readonly live: boolean }>(
  rows: readonly Row[],
  candidates: AgentCandidates,
): Row[] {
  const newestCardOfSession = new Map<string, string>();
  for (const id of candidates.ids) {
    const sessionId = candidates.sessionOf.get(id);
    if (sessionId !== undefined) newestCardOfSession.set(sessionId, id);
  }
  return rows.filter((row) => {
    const sessionId = candidates.sessionOf.get(row.id);
    if (sessionId !== undefined && newestCardOfSession.get(sessionId) !== row.id) return false;
    return candidates.newestTurn.has(row.id) || row.live;
  });
}
