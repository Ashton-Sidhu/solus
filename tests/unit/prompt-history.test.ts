import { describe, expect, test } from "bun:test";
import {
  loadPromptHistory,
  MAX_PROMPT_HISTORY,
  PROMPT_HISTORY_KEY,
  savePromptToHistory,
} from "@solus/workspace-ui/components/input/lib/prompt-history";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("prompt history", () => {
  test("a different mounted composer can recall the prompt after an interrupt", () => {
    // WHY: Ctrl+C refocuses the active composer, which can be a different
    // mounted Editor/Pill instance from the composer that sent the prompt.
    const storage = memoryStorage();
    const staleComposerHistory = loadPromptHistory(storage);

    savePromptToHistory(storage, "fix the interrupted request");

    expect(staleComposerHistory).toEqual([]);
    expect(loadPromptHistory(storage)).toEqual(["fix the interrupted request"]);
  });

  test("saving from a stale composer preserves prompts written by another composer", () => {
    const storage = memoryStorage();
    savePromptToHistory(storage, "first prompt");
    savePromptToHistory(storage, "second prompt");

    expect(loadPromptHistory(storage)).toEqual(["first prompt", "second prompt"]);
  });

  test("keeps the newest unique prompts within the history limit", () => {
    const storage = memoryStorage();
    for (let index = 0; index <= MAX_PROMPT_HISTORY; index++) {
      savePromptToHistory(storage, `prompt ${index}`);
    }
    savePromptToHistory(storage, `prompt ${MAX_PROMPT_HISTORY}`);

    const history = loadPromptHistory(storage);
    expect(history).toHaveLength(MAX_PROMPT_HISTORY);
    expect(history[0]).toBe("prompt 1");
    expect(history.at(-1)).toBe(`prompt ${MAX_PROMPT_HISTORY}`);
    expect(storage.getItem(PROMPT_HISTORY_KEY)).toBe(JSON.stringify(history));
  });
});
