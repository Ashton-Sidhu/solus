// Adapted from T3 Code apps/web/src/components/chat/MessagesTimeline.tsx getItemType (MIT, see UPSTREAM.md; pingdotgg/t3code#21269).
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import type { ThreadFeedRow } from "./thread-feed-presentation";

/**
 * The size class LegendList estimates a feed row by. The list gives a row it
 * has not measured the running average height of its type. With one type for
 * every reply, a few very long replies, or one that is streaming, lift the
 * estimate for short replies to thousands of points: earlier history then
 * mounts one row at a time, each measurement moves the anchor and mounts the
 * next. Doubling-length buckets, from 2,000 characters, keep each average
 * within about twice the rows it estimates.
 *
 * The streaming reply has a class of its own. The list keeps a row's class
 * until the feed's rows change, and a streamed token does not change them, so
 * the reply would otherwise add all its growth to the short bucket it started
 * in. It takes its length bucket when the turn moves on.
 *
 * Reads the row's item once, when the list asks; the feed itself does not
 * subscribe to the text.
 */
export function threadFeedItemType(
  row: ThreadFeedRow,
  item: TranscriptItem | undefined,
  streaming: boolean,
): string {
  if (row.type !== "message") return row.type;
  if (streaming) return `message:${row.role}:streaming`;
  const text = item?.kind === "user" || item?.kind === "assistant" ? item.text : "";
  const lengthBucket = Math.max(0, Math.floor(Math.log2(text.length / 1000)));
  // A prompt's attachments take a row the text length does not tell.
  const attachments = item?.kind === "user" && item.attachments.length > 0 ? ":attachments" : "";
  return `message:${row.role}:${lengthBucket}${attachments}`;
}

/** Rows that can follow the reply the agent is still writing. */
const LIVE_TAIL_ROWS: ReadonlySet<ThreadFeedRow["type"]> = new Set(["thinking", "handoff-pending", "turn-images"]);

/** The agent reply still growing at the end of an active turn, if any. */
export function streamingMessageRowId(rows: readonly ThreadFeedRow[], turnActive: boolean): string | null {
  if (!turnActive) return null;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.type === "message") return row.role === "assistant" ? row.id : null;
    if (!LIVE_TAIL_ROWS.has(row.type)) return null;
  }
  return null;
}
