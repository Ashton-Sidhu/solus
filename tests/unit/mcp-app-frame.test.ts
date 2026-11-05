import { afterEach, expect, spyOn, test } from 'bun:test'
import type { McpAppHostOptions } from '@solus/client-core/mcp-app-host'
import { connectMcpAppFrame, mcpAppContext } from '@solus/workspace-ui/components/conversation/lib/mcp-app-frame'

const originalObserver = globalThis.ResizeObserver
const originalWindow = globalThis.window
const originalComputedStyle = globalThis.getComputedStyle
afterEach(() => {
  globalThis.ResizeObserver = originalObserver
  globalThis.window = originalWindow
  globalThis.getComputedStyle = originalComputedStyle
})

function setup(isFullscreen = false) {
  let report: () => void = () => {}
  // SAFETY: the test drives the observer callback by hand; the code under test uses only observe and disconnect.
  globalThis.ResizeObserver = class { constructor(callback: () => void) { report = callback } observe() {} disconnect() {} } as unknown as typeof ResizeObserver
  // SAFETY: only the two listener methods of window are read.
  globalThis.window = { addEventListener() {}, removeEventListener() {} } as unknown as typeof globalThis.window
  const posted: string[] = []
  const frame = {
    clientWidth: 640,
    clientHeight: 320,
    addEventListener() {},
    removeEventListener() {},
    contentWindow: { postMessage: (message: { method?: string }) => { if (message.method) posted.push(message.method) } },
  }
  // SAFETY: the test frame has the fields connectMcpAppFrame reads.
  const element = frame as unknown as HTMLIFrameElement
  const context = () => ({ containerDimensions: { width: frame.clientWidth, maxHeight: 2000 } })
  // SAFETY: the bridge only forwards the context; its other callbacks are not reached here.
  const options = { snapshot: { html: '', toolInputJson: '{}', toolResultJson: '{}', csp: {} }, context } as unknown as Omit<McpAppHostOptions, 'post'>
  const connection = connectMcpAppFrame(element, options, () => {}, () => isFullscreen)
  return { frame, posted, connection, report: () => report() }
}

async function ready(host: ReturnType<typeof setup>['connection']['host']) {
  await host.receive(JSON.stringify({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }))
}

const contextChanges = (posted: string[]) => posted.filter((method) => method === 'ui/notifications/host-context-changed').length

test('an app hears of a new width, once', async () => {
  const s = setup()
  await ready(s.connection.host)
  s.report()
  s.frame.clientWidth = 700
  s.report()
  s.report()
  expect(contextChanges(s.posted)).toBe(2)
  s.connection.disconnect()
})

test("an inline frame's height change is the app's own report, so it does not go back to the app", async () => {
  const s = setup()
  await ready(s.connection.host)
  s.report()
  s.frame.clientHeight = 180
  s.report()
  expect(contextChanges(s.posted)).toBe(1)
  s.connection.disconnect()
})

test('a full-screen frame reports a change of its height', async () => {
  const s = setup(true)
  await ready(s.connection.host)
  s.report()
  s.frame.clientHeight = 500
  s.report()
  expect(contextChanges(s.posted)).toBe(2)
  s.connection.disconnect()
})

test('a hidden conversation keeps the size it last sent', async () => {
  const s = setup()
  await ready(s.connection.host)
  s.report()
  s.frame.clientWidth = 0
  s.report()
  expect(contextChanges(s.posted)).toBe(1)
  s.connection.disconnect()
})

test('the context gives the app its frame', () => {
  const style = spyOn({ getComputedStyle: () => ({ getPropertyValue: () => '' }) }, 'getComputedStyle')
  // SAFETY: mcpAppContext reads only getPropertyValue from the computed style.
  globalThis.getComputedStyle = style as unknown as typeof getComputedStyle
  // SAFETY: mcpAppContext reads documentElement only to pass it to the stub above.
  globalThis.document ??= {} as unknown as Document
  expect(mcpAppContext({ clientWidth: 640, clientHeight: 320 }, true, false).containerDimensions).toEqual({ width: 640, maxHeight: 2000 })
  expect(mcpAppContext({ clientWidth: 640, clientHeight: 320 }, true, true).containerDimensions).toEqual({ width: 640, height: 320 })
})
