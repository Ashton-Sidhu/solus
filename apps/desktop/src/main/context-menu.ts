import { Menu, nativeImage, shell, clipboard, type BrowserWindow } from 'electron'
import { conversationLinkAction } from './conversation-link-action'

function createTemplateMenuIcon(svg: string): Electron.NativeImage {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
  icon.setTemplateImage(true)
  return icon
}

// Phosphor "Quotes" icon as a 16x16 template image (black+transparent so
// macOS inverts it automatically for dark/light menus).
const quoteInReplyIcon = createTemplateMenuIcon(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256"><path fill="#000" d="M116,72v88a48.05,48.05,0,0,1-48,48H64a8,8,0,0,1,0-16H68a32,32,0,0,0,32-32v-8H48a16,16,0,0,1-16-16V72A16,16,0,0,1,48,56h52A16,16,0,0,1,116,72Zm96-16H160a16,16,0,0,0-16,16v64a16,16,0,0,0,16,16h52v8a32,32,0,0,1-32,32h-4a8,8,0,0,0,0,16h4a48.05,48.05,0,0,0,48-48V72A16,16,0,0,0,212,56Z"/></svg>'
)

/** Only http(s) links get link items — never file:, javascript:, or our own solus-img: scheme. */
function isSafeExternalUrl(url: string): boolean {
  if (!url) return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Native context menu for the workspace window. */
export function attachContextMenu(win: BrowserWindow, getQuoteTabId: () => string | null): void {
  win.webContents.on('context-menu', (_event, params) => {
    const quoteContextTabId = getQuoteTabId()
    const menuItems: Electron.MenuItemConstructorOptions[] = []

    const linkUrl = isSafeExternalUrl(params.linkURL) ? params.linkURL : null
    const openLink = conversationLinkAction(
      linkUrl,
      params.selectionText,
      quoteContextTabId,
      params.isEditable,
      (url, sourceTabId) => win.webContents.send('solus:open-selected-link', url, sourceTabId),
    )
    if (openLink) menuItems.push(openLink)
    if (linkUrl) {
      menuItems.push(
        { label: 'Open in default browser', click: () => void shell.openExternal(linkUrl) },
        { type: 'separator' },
        { label: 'Copy Link', click: () => clipboard.writeText(linkUrl) },
      )
    }
    if (openLink || linkUrl) menuItems.push({ type: 'separator' })

    // Corrections come first — a right-click on a red-underlined word is asking
    // for the suggestion, not for the clipboard.
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuItems.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        })
      }
      if (params.dictionarySuggestions.length === 0) {
        menuItems.push({ label: 'No suggestions', enabled: false })
      }
      menuItems.push({ type: 'separator' })
    }

    if (params.mediaType === 'image') {
      menuItems.push({
        label: 'Copy Image',
        click: () => win.webContents.copyImageAt(params.x, params.y),
      })
      menuItems.push({ type: 'separator' })
    }

    // Always present, disabled when they don't apply. Omitting them instead let
    // the template come out empty — right-clicking the transcript with nothing
    // selected popped no menu at all, which reads as a broken right-click.
    menuItems.push(
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll },
    )

    // Conversation output only: let the user pull a selected snippet into the
    // composer as a markdown blockquote to address that specific text.
    if (quoteContextTabId && params.selectionText && !params.isEditable) {
      const sourceTabId = quoteContextTabId
      menuItems.push({ type: 'separator' })
      menuItems.push({
        label: 'Quote in reply',
        icon: quoteInReplyIcon,
        click: () => win.webContents.send('solus:quote-selection', params.selectionText, sourceTabId),
      })
      menuItems.push({
        label: 'Ask in New Session',
        click: () => win.webContents.send(
          'solus:ask-selection-in-new-session',
          params.selectionText,
          sourceTabId,
        ),
      })
    }

    Menu.buildFromTemplate(menuItems).popup({ window: win })
  })
}

