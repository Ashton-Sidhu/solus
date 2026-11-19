import { localApi } from '@solus/client-core/local-api'
import { mcpAppContainerDimensions, mcpAppHostContext, type McpAppHostContext } from '@solus/client-core/mcp-app-context'
import { createMcpAppHost, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'
import { MCP_APP_PERMISSIONS, type McpAppPermission } from '@solus/contracts/mcp-apps'

/**
 * Connects an app iframe to its bridge. Only the frame's own messages reach the
 * bridge. A second load of the frame is a navigation: the bridge stops and
 * `onNavigated` runs. `disconnect` removes the listeners and stops the bridge.
 */
export function connectMcpAppFrame(
  frame: HTMLIFrameElement,
  options: Omit<McpAppHostOptions, 'post'>,
  onNavigated: () => void,
  isFullscreen: () => boolean,
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
      onNavigated()
    }
  }
  frame.addEventListener('load', loaded)
  window.addEventListener('message', receive)
  // An inline frame's height is the app's own report, so only a real change of its box reaches the app.
  let sentDimensions = ''
  const resizes = new ResizeObserver(() => {
    // A hidden conversation has no box. It keeps the size it last sent.
    if (!frame.clientWidth) return
    const dimensions = JSON.stringify(mcpAppFrameDimensions(frame, isFullscreen()))
    if (dimensions === sentDimensions) return
    sentDimensions = dimensions
    host.updateContext()
  })
  resizes.observe(frame)
  return {
    host,
    disconnect: () => {
      resizes.disconnect()
      frame.removeEventListener('load', loaded)
      window.removeEventListener('message', receive)
      host.dispose()
    },
  }
}

function mcpAppFrameDimensions(frame: Pick<HTMLIFrameElement, 'clientWidth' | 'clientHeight'>, isFullscreen: boolean) {
  return mcpAppContainerDimensions({ width: frame.clientWidth, height: frame.clientHeight }, isFullscreen)
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

/** The theme and size an app is given. It reads the live palette, so call it only at initialize and on a change. */
export function mcpAppContext(frame: Pick<HTMLIFrameElement, 'clientWidth' | 'clientHeight'>, isDark: boolean, isFullscreen: boolean): McpAppHostContext {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return mcpAppHostContext({
    theme: isDark ? 'dark' : 'light',
    isFullscreen,
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
