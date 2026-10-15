import type { Message } from "@solus/contracts/types";
import { isAgentNotice } from "../../../contexts/workspace/session.utils";

export interface ConversationFindMatch {
  messageId: string;
  occurrence: number;
}

export const CONVERSATION_BREADCRUMB_OFFSET = 58;

export function conversationFindTopInset(hasFloatingBreadcrumb: boolean): number {
  // The primary transcript is paint-contained below its floating breadcrumb, so
  // z-index cannot lift the find bar over that sibling stacking layer.
  return 8 + (hasFloatingBreadcrumb ? CONVERSATION_BREADCRUMB_OFFSET : 0);
}

export function isSearchableConversationMessage(message: Message): boolean {
  // A notice renders as a transient pill rather than as body text, whichever
  // role it arrived on — a match inside one is a hit find could never reach.
  if (isAgentNotice(message.content)) return false;
  if (message.role === "user") return true;
  if (message.role !== "assistant") return false;
  return !(
    message.workRef ||
    message.artifact ||
    message.automationRef ||
    message.taskRef ||
    message.agentConversationRef
  );
}

/** How many matches a message showed on screen, for the content it had then. */
export interface VisibleMatchCount {
  content: string;
  count: number;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let start = content.indexOf(needle);
  while (start !== -1) {
    count++;
    start = content.indexOf(needle, start + needle.length);
  }
  return count;
}

/*
 * The markdown is an estimate of what the reader can find: a link target, the
 * folders a file chip hides, and fence syntax are in the source but not on
 * screen. Once a message has been on screen, its visible count replaces the
 * estimate.
 */
export function findConversationMatches(
  messages: Message[],
  query: string,
  visibleCounts: ReadonlyMap<string, VisibleMatchCount> = new Map(),
): ConversationFindMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: ConversationFindMatch[] = [];
  for (const message of messages) {
    if (!isSearchableConversationMessage(message)) continue;
    const visible = visibleCounts.get(message.id);
    const count =
      visible?.content === message.content
        ? visible.count
        : countOccurrences(message.content.toLocaleLowerCase(), needle);
    for (let occurrence = 0; occurrence < count; occurrence++) {
      matches.push({ messageId: message.id, occurrence });
    }
  }
  return matches;
}

export function indexOfConversationMatch(
  matches: ConversationFindMatch[],
  match: ConversationFindMatch | null,
): number {
  if (!match) return -1;
  return matches.findIndex(
    (candidate) =>
      candidate.messageId === match.messageId &&
      candidate.occurrence === match.occurrence,
  );
}

/** The match after (or before) `from`, also when `from` is no longer counted. */
export function stepConversationMatch(
  matches: ConversationFindMatch[],
  messages: Message[],
  from: ConversationFindMatch | null,
  direction: 1 | -1,
): ConversationFindMatch | undefined {
  if (matches.length === 0) return undefined;
  if (!from) return direction === 1 ? matches[0] : matches.at(-1);
  const index = indexOfConversationMatch(matches, from);
  if (index !== -1) return matches.at((index + direction) % matches.length);

  const order = new Map(messages.map((message, i) => [message.id, i]));
  const position = (match: ConversationFindMatch) => order.get(match.messageId) ?? -1;
  let after = matches.findIndex(
    (match) =>
      position(match) > position(from) ||
      (match.messageId === from.messageId && match.occurrence > from.occurrence),
  );
  if (after === -1) after = matches.length;
  return direction === 1 ? matches[after % matches.length] : matches.at(after - 1);
}
