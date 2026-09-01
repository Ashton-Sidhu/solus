export const PROMPT_HISTORY_KEY = "solus-prompt-history";
export const MAX_PROMPT_HISTORY = 100;

export function loadPromptHistory(storage: Pick<Storage, "getItem">): string[] {
  try {
    const stored = storage.getItem(PROMPT_HISTORY_KEY);
    if (!stored) return [];
    const history: unknown = JSON.parse(stored);
    return Array.isArray(history) && history.every((entry) => typeof entry === "string")
      ? history
      : [];
  } catch {
    return [];
  }
}

export function savePromptToHistory(
  storage: Pick<Storage, "getItem" | "setItem">,
  text: string,
): string[] {
  const history = loadPromptHistory(storage);
  if (!text || history.at(-1) === text) return history;

  history.push(text);
  if (history.length > MAX_PROMPT_HISTORY) history.shift();
  storage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(history));
  return history;
}
