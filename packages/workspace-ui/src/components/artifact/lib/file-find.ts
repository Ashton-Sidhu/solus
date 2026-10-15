export interface FileFindPaneBounds {
  top: number;
  left: number;
  width: number;
}

export function fileFindPosition(bounds: FileFindPaneBounds) {
  return {
    top: bounds.top + 8,
    left: bounds.left,
    width: bounds.width,
  };
}

export function isFileFindShortcut(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  // ⇧ is excluded so ⌘⇧F still reaches the dispatcher as project search.
  return (
    event.code === "KeyF" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function shouldRestoreFileEditorFocus(
  wasFindOpen: boolean,
  isFindOpen: boolean,
): boolean {
  return wasFindOpen && !isFindOpen;
}

/** Keep Pierre's find input focused until its arrow button receives the click. */
export function preserveFileFindNavigationFocus(event: MouseEvent): boolean {
  const isNavigationControl = event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement && target.dataset.searchNav !== undefined,
    );
  if (isNavigationControl) event.preventDefault();
  return isNavigationControl;
}
