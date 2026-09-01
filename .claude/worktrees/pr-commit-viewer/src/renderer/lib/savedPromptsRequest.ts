/**
 * Bridge from global surfaces (the command palette) to the composer-local saved
 * prompts control, mirroring `requestInputFocus`: the palette is a modal that
 * knows nothing about which composer is focused, and the control already gates
 * itself on being the active one.
 */
export const SAVED_PROMPTS_EVENT = "solus:saved-prompts";

export interface SavedPromptsRequest {
  action: "save" | "open";
  /** Omit to let whichever composer is currently focused answer. */
  tabId?: string;
}

export function requestSavedPrompts(request: SavedPromptsRequest) {
  window.dispatchEvent(
    new CustomEvent(SAVED_PROMPTS_EVENT, { detail: request }),
  );
}
