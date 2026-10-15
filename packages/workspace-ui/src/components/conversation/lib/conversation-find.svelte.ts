import type { Message } from "@solus/contracts/types";
import { SvelteMap } from "svelte/reactivity";
import {
  findConversationMatches,
  indexOfConversationMatch,
  stepConversationMatch,
  type ConversationFindMatch,
  type VisibleMatchCount,
} from "./find";
import { ConversationFindHighlighter } from "./find-highlight";

/**
 * Find in one conversation. Matches are counted from the markdown until a
 * message is on screen; from then on, from what the reader sees there. A match
 * that is not on screen is skipped, so the active match is always one the
 * reader can see.
 */
export class ConversationFind {
  isOpen = $state(false);
  query = $state("");
  active = $state<ConversationFindMatch | null>(null);
  readonly highlighter = new ConversationFindHighlighter();
  private readonly visibleCounts = new SvelteMap<string, VisibleMatchCount>();
  private readonly messages: () => Message[];
  private readonly reveal: (match: ConversationFindMatch) => Promise<void>;
  private navigation = 0;

  readonly matches = $derived.by(() =>
    findConversationMatches(this.messages(), this.query, this.visibleCounts),
  );
  /** One-based position of the active match; 0 when there is none. */
  readonly position = $derived.by(
    () => indexOfConversationMatch(this.matches, this.active) + 1,
  );

  constructor(
    messages: () => Message[],
    reveal: (match: ConversationFindMatch) => Promise<void>,
  ) {
    this.messages = messages;
    this.reveal = reveal;
  }

  setQuery(value: string) {
    this.navigation++;
    this.query = value;
    this.active = null;
    this.visibleCounts.clear();
  }

  async step(direction: 1 | -1) {
    const navigation = ++this.navigation;
    let target = stepConversationMatch(this.matches, this.messages(), this.active, direction);
    // Each failed reveal replaces one message's estimate with its visible
    // count, so the walk ends within the number of matches.
    for (let attempts = this.matches.length; target && attempts > 0; attempts--) {
      this.active = target;
      await this.reveal(target);
      if (navigation !== this.navigation) return;
      this.recordVisibleCounts();
      if (indexOfConversationMatch(this.matches, target) !== -1) return;
      target = stepConversationMatch(this.matches, this.messages(), target, direction);
    }
    if (!target) this.active = null;
  }

  paint(root: HTMLElement | null) {
    this.highlighter.update(root, this.query, this.active);
    this.recordVisibleCounts();
  }

  close() {
    this.setQuery("");
    this.isOpen = false;
    this.highlighter.clear();
  }

  destroy() {
    this.highlighter.destroy();
  }

  private recordVisibleCounts() {
    if (this.highlighter.visibleCounts.size === 0) return;
    const contentById = new Map(this.messages().map((message) => [message.id, message.content]));
    for (const [messageId, count] of this.highlighter.visibleCounts) {
      const content = contentById.get(messageId);
      if (content === undefined) continue;
      const known = this.visibleCounts.get(messageId);
      if (known?.content === content && known.count === count) continue;
      this.visibleCounts.set(messageId, { content, count });
    }
  }
}
