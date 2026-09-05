import type { BrowserAgentUse } from "@solus/contracts/browser-types"

/** Verb names as a sentence fragment. An unmapped verb falls back to its own
 *  name, which is still better than "doing something". */
const PHRASE_FOR = new Map<string, string>([
  ["browser_open", "opening this page"],
  ["browser_navigate", "navigating this page"],
  ["browser_resize", "resizing this page"],
  ["browser_set_appearance", "changing this page's appearance"],
  ["browser_snapshot", "taking a snapshot of this page"],
  ["browser_click", "clicking in this page"],
  ["browser_type", "typing in this page"],
  ["browser_press", "pressing a key in this page"],
  ["browser_scroll", "scrolling this page"],
  ["browser_evaluate", "reading this page"],
  ["browser_wait_for", "waiting on this page"],
])

/** How the host's refusal reads: a verb in flight is one sentence, a turn
 *  between verbs is another. Never used to gate the close — the host does that. */
export function agentUseSentence(use: BrowserAgentUse): string {
  const phrase = PHRASE_FOR.get(use.verb) ?? use.verb
  return use.running > 0
    ? `An agent is ${phrase} right now.`
    : `An agent was ${phrase} a moment ago.`
}
