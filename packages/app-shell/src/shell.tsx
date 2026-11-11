/**
 * The frame page an app runs in (docs/plans/apps.md §4). Built once into
 * `resources/app-shell/shell.js` by `scripts/build-app-shell.ts`; the server
 * inlines it into every app's document, so no frame ever needs the network.
 *
 * The document calls `SolusAppShell.define(...)` with the compiled component
 * as an inline script, then `SolusAppShell.mount(config)`. Nothing is
 * evaluated from a string: the MCP App policy has no `unsafe-eval`.
 */

import './theme-style'
import '@tailwindcss/browser'
import { Component, StrictMode, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppContext, type AppHostAccessState, type AppPermissionsState, type AppRoleState } from './app-context'
import { createStorage } from './app-storage'
import { HostBridge, type HostTheme } from './host-bridge'
import { createRequire, type ComponentRequire } from './modules'
import { createCallProxy, functionWireName, SERVER_ROOT, TOOLS_ROOT, toolWireName } from './tools-proxy'
import { Card, CardDescription, CardTitle } from './ui/index'

/** What the compiled module may export: its default is the component the shell mounts. */
interface ComponentExports {
  default?: ComponentType
}

type ComponentBody = (require: ComponentRequire, module: { exports: ComponentExports }, exports: ComponentExports) => void

export interface ShellConfig {
  roles: AppRoleState[]
  permissions: AppPermissionsState
  hostAccess: AppHostAccessState
}

const bridge = new HostBridge()
const componentRequire = createRequire({
  tools: createCallProxy(TOOLS_ROOT, ({ path, args }) => bridge.callTool(toolWireName(path), args)),
  storage: createStorage((name, args) => bridge.callValue(name, args)),
  server: createCallProxy(SERVER_ROOT, ({ path, args }) => bridge.callValue(functionWireName(path), args)),
})
let definedBody: ComponentBody | null = null

/** Registers the compiled component. Called by the inline script the server writes before `mount`. */
function define(body: ComponentBody): void {
  definedBody = body
}

function loadComponent(): ComponentType {
  if (!definedBody) throw new Error('This app has no component. The compiled source was not written into the page.')
  const exports: ComponentExports = {}
  const module = { exports }
  definedBody(componentRequire, module, module.exports)
  const exported = module.exports.default
  // A default that is not a component fails in the error boundary with React's own message.
  if (!exported) throw new Error('The app must export default a React component.')
  return exported
}

interface LoadedComponent {
  component: ComponentType | null
  error: Error | null
}

/** The component, or why it could not load; read once per mount. */
function loadComponentOnce(): LoadedComponent {
  try {
    return { component: loadComponent(), error: null }
  } catch (error) {
    return { component: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

interface BoundaryState {
  error: Error | null
}

class Boundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <Card role="alert" className="border-destructive/40">
        <CardTitle>This app hit an error</CardTitle>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs text-destructive">{error.message}</pre>
        <CardDescription className="mt-2">Ask the agent to fix it with create_app, then reload the app.</CardDescription>
      </Card>
    )
  }
}

function RolesNotice({ roles }: { roles: AppRoleState[] }) {
  const missing = roles.filter((role) => !role.connected)
  if (!missing.length) return null
  return (
    <Card className="mb-3">
      <CardTitle>Connect to use this app</CardTitle>
      <CardDescription className="mt-1">
        This app reads {missing.map((role) => role.name ?? role.slug).join(', ')} with your own account. Connect {missing.length === 1 ? 'it' : 'them'} in Settings → MCP, then reload the app.
      </CardDescription>
    </Card>
  )
}

function HostAccessNotice({ hostAccess }: { hostAccess: AppHostAccessState }) {
  if (hostAccess !== 'pending') return null
  return (
    <Card className="mb-3">
      <CardTitle>This app waits for its host access</CardTitle>
      <CardDescription className="mt-1">
        It asks to run code on its host or to reach the network. The owner of the host allows that in the app's header. Until then, those parts of the app do not work.
      </CardDescription>
    </Card>
  )
}

function useHeightReporter() {
  useEffect(() => {
    let last = 0
    const report = () => {
      // The body's own height: the root is as tall as the frame, so its scroll height would only ever grow.
      const height = Math.ceil(document.body.scrollHeight)
      if (height === last) return
      last = height
      bridge.reportHeight(height)
    }
    const observer = new ResizeObserver(report)
    observer.observe(document.body)
    report()
    return () => observer.disconnect()
  }, [])
}

function Root({ config }: { config: ShellConfig }) {
  const [theme, setTheme] = useState<HostTheme>(bridge.theme)
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }), [])
  const [loaded] = useState(loadComponentOnce)
  // The host may have answered `ui/initialize` before this effect ran: read the theme it left, then follow changes.
  useEffect(() => {
    setTheme(bridge.theme)
    return bridge.onTheme(setTheme)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])
  useHeightReporter()

  const state = useMemo(() => ({ roles: config.roles, permissions: config.permissions, hostAccess: config.hostAccess, theme }), [config, theme])
  const AppComponent = loaded.component
  return (
    <AppContext.Provider value={state}>
      <QueryClientProvider client={queryClient}>
        <div className="p-3 font-sans text-sm text-foreground">
          <RolesNotice roles={config.roles} />
          <HostAccessNotice hostAccess={config.hostAccess} />
          {loaded.error ? (
            <Card role="alert" className="border-destructive/40">
              <CardTitle>This app could not start</CardTitle>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs text-destructive">{loaded.error.message}</pre>
            </Card>
          ) : AppComponent ? (
            <Boundary>
              <AppComponent />
            </Boundary>
          ) : null}
        </div>
      </QueryClientProvider>
    </AppContext.Provider>
  )
}

function mount(config: ShellConfig): void {
  const container = document.getElementById('solus-app-root') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'solus-app-root' }))
  void bridge.initialize().catch(() => {
    // Without a host (a plain preview), the app still mounts with the light theme.
  })
  createRoot(container).render(
    <StrictMode>
      <Root config={config} />
    </StrictMode>,
  )
}

declare global {
  interface Window {
    SolusAppShell: { define: typeof define; mount: typeof mount }
  }
}

window.SolusAppShell = { define, mount }
