import { createMcpAppHost, mcpAppContainerDimensions, type McpAppHostContext, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'

/**
 * The three host calls a frame's app makes, bound to what the app is: a
 * captured MCP App answers them through its session activity, an `app` work
 * (docs/plans/apps.md) through its work id. The frame is the same either way.
 */
export type McpAppCalls = Pick<McpAppHostOptions, 'toolInfo' | 'callTool' | 'readResource'>

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

/** The theme and size an app is given. It reads the live palette, so call it only at initialize and on a change. */
export function mcpAppContext(frame: Pick<HTMLIFrameElement, 'clientWidth' | 'clientHeight'>, isDark: boolean, isFullscreen: boolean): McpAppHostContext {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    theme: isDark ? 'dark' : 'light',
    displayMode: isFullscreen ? 'fullscreen' : 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: mcpAppFrameDimensions(frame, isFullscreen),
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
