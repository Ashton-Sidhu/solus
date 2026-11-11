import { useState } from "react";
import type { VoiceDictionary } from "@solus/contracts/voice-dictionary";
import { useApp, useListened } from "../../app/app-context";

/** The saved dictionary, and one way to change it. Every change saves at once; a refused one leaves the saved list as it was and sets `error`. */
export function useVoiceDictionary() {
  const app = useApp();
  const entries = useListened(app.personal.changes, () => app.personal.current().voiceDictionary);
  const [error, setError] = useState<string | null>(null);

  function commit(change: (current: VoiceDictionary) => VoiceDictionary): boolean {
    let failure = "Could not save the dictionary";
    try {
      if (app.personal.set({ voiceDictionary: change(app.personal.current().voiceDictionary) }) === "saved") {
        setError(null);
        return true;
      }
    } catch (error) {
      if (error instanceof Error) failure = error.message;
    }
    setError(failure);
    return false;
  }

  return { entries, error, commit, clearError: () => setError(null) };
}
