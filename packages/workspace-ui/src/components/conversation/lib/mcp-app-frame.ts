import { localApi } from '@solus/client-core/local-api'
import { mcpAppAvailableDisplayModes, mcpAppContainerDimensions, mcpAppHostContext, type McpAppDisplayMode, type McpAppHostContext } from '@solus/client-core/mcp-app-context'
import { createMcpAppHost, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'
import { MCP_APP_PERMISSIONS, type McpAppPermission } from '@solus/contracts/mcp-apps'

/** What the frame's component tells the connection, and hears from it. */
export interface McpAppFrameView {
  /** A second load of the frame: a navigation. */
  onNavigated(): void
  displayMode(): McpAppDisplayMode
  /** The width of the conversation the frame is in, each time it changes. A hidden conversation reports nothing. */
  onConversationWidth(width: number): void
}

/**
 * Connects an app iframe to its bridge. Only the frame's own messages reach the
 * bridge. A second load of the frame is a navigation: the bridge stops and
 * `onNavigated` runs. `disconnect` removes the listeners and stops the bridge.
 */
export function connectMcpAppFrame(
  frame: HTMLIFrameElement,
  options: Omit<McpAppHostOptions, 'post'>,
  view: McpAppFrameView,
) {
  const host = createMcpAppHost({ ...options, post: (json) => frame.contentWindow?.postMessage(JSON.parse(json), '*') })
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return
    let json: string | undefined
    try {
      json = JSON.stringify(event.data)
    } catch {
      return // An app message must be JSON.
    }
    if (json) void host.receive(json)
  }
  let loads = 0
  const loaded = () => {
    loads++
    if (loads > 1) {
      host.dispose()
      view.onNavigated()
    }
  }
  frame.addEventListener('load', loaded)
  window.addEventListener('message', receive)
  // An inline frame's height is the app's own report, so only a real change of its box reaches the app.
  let sentDimensions = ''
  const resizes = new ResizeObserver(() => {
    // A hidden conversation has no box. It keeps the size it last sent.
    if (!frame.clientWidth) return
    const dimensions = JSON.stringify(mcpAppFrameDimensions(frame, view.displayMode()))
    if (dimensions === sentDimensions) return
    sentDimensions = dimensions
    host.updateContext()
  })
  resizes.observe(frame)
  // Picture-in-picture fits only a wide enough conversation, so the frame follows its width.
  const conversation = frame.closest(CONVERSATION_SELECTOR)
  const conversationResizes = new ResizeObserver(() => {
    if (conversation?.clientWidth) view.onConversationWidth(conversation.clientWidth)
  })
  if (conversation) conversationResizes.observe(conversation)
  return {
    host,
    disconnect: () => {
      resizes.disconnect()
      conversationResizes.disconnect()
      frame.removeEventListener('load', loaded)
      window.removeEventListener('message', receive)
      host.dispose()
    },
  }
}

/** The conversation a frame floats over in picture-in-picture (`ConversationView`). */
const CONVERSATION_SELECTOR = '[data-slot="conversation"]'

function mcpAppFrameDimensions(frame: Pick<HTMLIFrameElement, 'clientWidth' | 'clientHeight'>, displayMode: McpAppDisplayMode) {
  return mcpAppContainerDimensions({ width: frame.clientWidth, height: frame.clientHeight }, displayMode)
}

/** The transcript turn a card renders in; the virtualizer keeps it mounted while its frame is in picture-in-picture. */
export function mcpAppTurnKey(element: Element): string | undefined {
  return element.closest<HTMLElement>('[data-transcript-turn-id]')?.dataset.transcriptTurnId
}

/** The desktop app runs Electron; the web client reports itself as `web`. */
function mcpAppPlatform(): 'web' | 'desktop' {
  return localApi.getPlatform?.() === 'web' ? 'web' : 'desktop'
}

/**
 * The features this client can give an app frame. Each one needs a secure
 * page. The desktop app has no macOS camera or location usage text, so the
 * system refuses those; a browser asks the person itself.
 */
export function mcpAppSupportedPermissions(): McpAppPermission[] {
  if (!globalThis.isSecureContext) return []
  return mcpAppPlatform() === 'desktop' ? ['microphone', 'clipboardWrite'] : [...MCP_APP_PERMISSIONS]
}

/**
 * The theme, mode, and size an app is given. `conversationWidth` decides if
 * `pip` is offered. It reads the live palette, so call it only at initialize
 * and on a change.
 */
export function mcpAppContext(
  frame: Pick<HTMLIFrameElement, 'clientWidth' | 'clientHeight'>,
  isDark: boolean,
  displayMode: McpAppDisplayMode,
  conversationWidth: number,
): McpAppHostContext {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return mcpAppHostContext({
    theme: isDark ? 'dark' : 'light',
    displayMode,
    availableDisplayModes: mcpAppAvailableDisplayModes({ conversationWidth }),
    size: { width: frame.clientWidth, height: frame.clientHeight },
    platform: mcpAppPlatform(),
    touch: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
    hover: globalThis.matchMedia?.('(hover: hover)').matches ?? true,
    palette: {
      background: read('--solus-container-bg'),
      raised: read('--solus-render-raised'),
      strong: read('--solus-surface-hover'),
      text: read('--solus-text-primary'),
      textSecondary: read('--solus-text-secondary'),
      textTertiary: read('--solus-text-tertiary'),
      border: read('--solus-render-border'),
      accent: read('--solus-accent'),
      info: read('--solus-status-unread'),
      danger: read('--solus-status-error'),
      success: read('--solus-status-complete'),
      warning: read('--warning'),
      fontSans: read('--solus-font-family'),
      fontMono: read('--solus-code-font-family'),
    },
  })
}
