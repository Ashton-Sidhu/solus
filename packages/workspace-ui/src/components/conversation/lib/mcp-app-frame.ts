import { createMcpAppHost, type McpAppHostContext, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'

/**
 * Connects an app iframe to its bridge. Only the frame's own messages reach the
 * bridge. A second load of the frame is a navigation: the bridge stops and
 * `onNavigated` runs. `disconnect` removes the listeners and stops the bridge.
 */
export function connectMcpAppFrame(
  frame: HTMLIFrameElement,
  options: Omit<McpAppHostOptions, 'post'>,
  onNavigated: () => void,
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
  return {
    host,
    disconnect: () => {
      frame.removeEventListener('load', loaded)
      window.removeEventListener('message', receive)
      host.dispose()
    },
  }
}

/** The theme an app is given. It reads the live palette, so call it only at initialize and on a change. */
export function mcpAppContext(isDark: boolean, isFullscreen: boolean): McpAppHostContext {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    theme: isDark ? 'dark' : 'light',
    displayMode: isFullscreen ? 'fullscreen' : 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    platform: 'web',
    styles: {
      variables: {
        '--color-background-primary': read('--solus-container-bg'),
        '--color-background-secondary': read('--solus-render-raised'),
        '--color-text-primary': read('--solus-text-primary'),
        '--color-text-secondary': read('--solus-text-secondary'),
        '--color-border-primary': read('--solus-render-border'),
        '--font-sans': read('--solus-font-family'),
      },
    },
  }
}
