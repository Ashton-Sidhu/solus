import type { MenuItemConstructorOptions } from 'electron'
import { selectedWebUrl } from '@solus/workspace-ui/components/conversation/lib/external-link'

/** Add to the native text menu without taking over clipboard or quote actions. */
export function selectedConversationLinkAction(
  text: string,
  sourceTabId: string | null,
  isEditable: boolean,
  onOpen: (url: string, sourceTabId: string) => void,
): MenuItemConstructorOptions | null {
  if (!sourceTabId || isEditable) return null
  const url = selectedWebUrl(text)
  if (!url) return null
  return {
    label: 'Open link',
    click: () => onOpen(url, sourceTabId),
  }
}
