import type { ThreadFeedRow } from "../features/threads/pending-thread-feed";

/** Returns rows.length when the native list should display the opening itself. */
export function openingHistoryStart(rows: readonly ThreadFeedRow[]): number {
  const last = rows.at(-1);
  if (last?.type !== "message" || last.message.role !== "assistant") return rows.length;

  let messages = 0;
  let first = rows.length;
  // Bound the work even when a history page contains many consecutive tool rows.
  const limit = Math.max(0, rows.length - 8);
  while (first > limit && messages < 4) {
    const row = rows[first - 1]!;
    if (row.type === "message" && !row.message.attachments?.length) {
      messages++;
    } else if (row.type !== "run-fold" || row.expanded || row.workingSince) {
      break;
    }
    first--;
  }
  return first === 0 || messages >= 3 ? first : rows.length;
}
