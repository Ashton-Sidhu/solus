import type { SessionReference } from "@solus/contracts/types";
import {
  parseSessionReferences,
  sessionReferenceHref,
  sessionReferenceMarkdown,
} from "@solus/contracts/session-link";
import { parseReferenceTokens } from "../components/editor/reference-tokens";

/**
 * A session dragged from the sidebar into a composer. The drag carries the
 * same `SessionReference` the composer's session picker inserts, so a dropped
 * session becomes the same `session://ref` chip and reaches the agent the same
 * way: by id and host, never by a local path.
 */
export const SESSION_DRAG_TYPE = "application/x-solus-session-refs";

interface DragData {
  readonly types: readonly string[];
  getData(format: string): string;
}

interface WritableDragData {
  setData(format: string, data: string): void;
  effectAllowed: DataTransfer["effectAllowed"];
}

/** Put the sessions on a drag. Other targets read the uri-list or the text. */
export function writeSessionDrag(data: WritableDragData, references: readonly SessionReference[]): void {
  data.setData(SESSION_DRAG_TYPE, JSON.stringify(references));
  data.setData("text/uri-list", references.map(sessionReferenceHref).join("\r\n"));
  data.setData("text/plain", references.map(sessionReferenceMarkdown).join(" "));
  data.effectAllowed = "copyLink";
}

/** Whether a drag holds sessions. A drag's data is unreadable until the drop,
 *  but its types are not. */
export function carriesSessionDrag(data: Pick<DragData, "types"> | null | undefined): boolean {
  return !!data && Array.from(data.types).includes(SESSION_DRAG_TYPE);
}

/** The sessions a drop holds. A foreign or malformed payload holds none. */
export function readSessionDrag(data: DragData | null | undefined): SessionReference[] {
  if (!data || !carriesSessionDrag(data)) return [];
  return parseSessionReferences(data.getData(SESSION_DRAG_TYPE));
}

export interface SessionDropInsertion {
  from: number;
  insert: string;
}

/**
 * Where the dropped sessions go in `text` and what is written there. A drop on
 * a chip lands after it, never inside its source, and each chip keeps a space
 * on both sides so it stays a token.
 */
export function sessionDropInsertion(
  text: string,
  position: number,
  references: readonly SessionReference[],
): SessionDropInsertion | null {
  if (references.length === 0) return null;
  let from = Math.max(0, Math.min(position, text.length));
  const chip = parseReferenceTokens(text).find((range) => from > range.from && from < range.to);
  if (chip) from = chip.to;
  const before = from > 0 ? text[from - 1] : "";
  const leading = before && !/\s/.test(before) ? " " : "";
  return { from, insert: `${leading}${references.map(sessionReferenceMarkdown).join(" ")} ` };
}

/** The mounted composers that can take a reference, newest last. */
const promptTargets = new Set<(references: readonly SessionReference[]) => boolean>();

/**
 * The keyboard way to do what a drop does: ask the composer that has the
 * keyboard to add the sessions' chips at its caret. False when none took them.
 */
export function referenceSessionsInPrompt(references: readonly SessionReference[]): boolean {
  for (const insert of promptTargets) if (insert(references)) return true;
  return false;
}

/** Take `referenceSessionsInPrompt` requests. The handler answers whether it
 *  inserted the chips; the first one that does ends the request. */
export function onReferenceSessionsRequest(
  insert: (references: readonly SessionReference[]) => boolean,
): () => void {
  promptTargets.add(insert);
  return () => promptTargets.delete(insert);
}
