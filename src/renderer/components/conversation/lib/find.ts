import type { Message } from "../../../../shared/types";
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

export function findConversationMatches(
  messages: Message[],
  query: string,
): ConversationFindMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: ConversationFindMatch[] = [];
  for (const message of messages) {
    if (!isSearchableConversationMessage(message)) continue;
    const content = message.content.toLocaleLowerCase();
    let start = content.indexOf(needle);
    let occurrence = 0;
    while (start !== -1) {
      matches.push({ messageId: message.id, occurrence });
      occurrence++;
      start = content.indexOf(needle, start + needle.length);
    }
  }
  return matches;
}
