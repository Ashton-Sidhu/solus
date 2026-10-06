import type { MenuItemConstructorOptions } from 'electron'
import { selectedWebUrl } from '@solus/workspace-ui/components/conversation/lib/external-link'

/** Add to the native text menu without taking over clipboard or quote actions.
 *  The link under the pointer wins; otherwise the selection must be one address. */
export function conversationLinkAction(
  linkUrl: string | null,
  selectionText: string,
  sourceTabId: string | null,
  isEditable: boolean,
  onOpen: (url: string, sourceTabId: string) => void,
): MenuItemConstructorOptions | null {
  if (!sourceTabId || isEditable) return null
  const url = linkUrl ?? selectedWebUrl(selectionText)
  if (!url) return null
  return {
    label: 'Open link',
    click: () => onOpen(url, sourceTabId),
  }
}
