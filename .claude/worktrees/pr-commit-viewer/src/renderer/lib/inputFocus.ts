// Deep import (not the barrel): workspace.context and servers.store import this
// module, so importing contexts/index here would create a cycle.
import { runtime } from "../contexts/app/runtime.svelte";

export const FOCUS_INPUT_EVENT = "solus:focus-input";

export function requestInputFocus(target?: { tabId?: string }) {
  if (runtime.shouldSuppressFocus) return;
  window.dispatchEvent(new CustomEvent(FOCUS_INPUT_EVENT, { detail: target }));
}

export function blurActiveTextInputOnMobile() {
  if (!runtime.shouldSuppressFocus) return;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return;

  const isTextInput =
    active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.isContentEditable;

  if (isTextInput) active.blur();
}
