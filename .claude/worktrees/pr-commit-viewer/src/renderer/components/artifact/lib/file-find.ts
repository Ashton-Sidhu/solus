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
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey">,
): boolean {
  return (
    event.code === "KeyF" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey
  );
}

export function shouldRestoreFileEditorFocus(
  wasFindOpen: boolean,
  isFindOpen: boolean,
): boolean {
  return wasFindOpen && !isFindOpen;
}
