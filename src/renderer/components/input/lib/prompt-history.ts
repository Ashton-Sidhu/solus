export const PROMPT_HISTORY_KEY = "solus-prompt-history";
export const MAX_PROMPT_HISTORY = 100;
import { z } from "zod";

const promptHistorySchema = z.array(z.string());

export function loadPromptHistory(storage: Pick<Storage, "getItem">): string[] {
  try {
    const stored = storage.getItem(PROMPT_HISTORY_KEY);
    if (!stored) return [];
    const history = promptHistorySchema.safeParse(JSON.parse(stored));
    return history.success ? history.data : [];
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
