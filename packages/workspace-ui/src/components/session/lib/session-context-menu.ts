interface SelectSessionRenameOptions {
  tabId: string | null;
  onStartRename?: (tabId: string) => void;
  onDefaultRename: (tabId: string) => void;
  onClose: () => void;
}

/** Preserve the selected tab before closing the menu. Closing clears the
 * sidebar's reactive menu target, but the rename action still needs its id. */
export function selectSessionRename({
  tabId,
  onStartRename,
  onDefaultRename,
  onClose,
}: SelectSessionRenameOptions): void {
  const targetTabId = tabId;
  const startInPlace = onStartRename;
  onClose();
  if (!targetTabId) return;
  if (startInPlace) startInPlace(targetTabId);
  else onDefaultRename(targetTabId);
}
