import { runtime } from "../contexts/runtime.svelte";

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
