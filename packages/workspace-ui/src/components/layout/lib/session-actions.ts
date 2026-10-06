import type { Component } from "svelte";

/** One thing the user can do to the session in a tab. The action row shows the
 *  available ones as icons; the action list (⌥⇧Q) shows the same list by name,
 *  so the two can never disagree about what is possible. */
export type SessionAction = {
  id: string;
  label: string;
  icon: Component<{ size?: number }>;
  /** Formatted default shortcut, or "" when the action has none. */
  shortcut: string;
  isDisabled?: boolean;
  run: () => void;
};

/** Keeps the actions whose label contains every word of the query, in their
 *  row order, with labels that start with the first word ahead of the rest. */
export function filterSessionActions(
  actions: readonly SessionAction[],
  query: string,
): SessionAction[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...actions];
  const matches = actions.filter((action) => {
    const label = action.label.toLowerCase();
    return words.every((word) => label.includes(word));
  });
  const startsWithFirstWord = (action: SessionAction) =>
    action.label.toLowerCase().startsWith(words[0]);
  return [
    ...matches.filter(startsWithFirstWord),
    ...matches.filter((action) => !startsWithFirstWord(action)),
  ];
}

