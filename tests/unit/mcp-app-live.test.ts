import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { mcpAppHostContext, type McpAppPalette } from '@solus/client-core/mcp-app-context'
import { createMcpAppHost, MCP_APP_CAPTURE_WAIT_MS, MCP_APP_PARTIAL_INPUT_INTERVAL_MS, type McpAppClock, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'
import { healPartialJson } from '@solus/client-core/partial-json'
import { McpAppLiveCards, mcpAppLiveCall } from '@solus/client-core/mcp-app-live'
import { mcpAppLiveToolName, type McpAppCancelReason, type McpAppLiveDocument } from '@solus/contracts/mcp-apps'

// WHY: a live app card shows an MCP App while its tool call runs
// (docs/plans/mcp-first-class.md §14.1). The app must get the call in the
// order of the MCP Apps specification, must not be flooded by streamed
// tokens, and must never act for the host before the call has a result.

const palette = { background: '#111', raised: '#222', strong: '#333', text: '#eee', textSecondary: '#aaa', textTertiary: '#888', border: '#444', accent: '#d97757', info: '#7cc0ea', danger: '#e3645e', success: '#5a9e6f', warning: '#fbbf24', fontSans: 'system-ui', fontMono: 'monospace' } satisfies McpAppPalette
const context = mcpAppHostContext({ theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], size: { width: 640, height: 320 }, platform: 'web', touch: false, hover: true, palette })
const liveDocument: McpAppLiveDocument = { title: 'Charts · chart', html: '<div id="chart"></div>', csp: {} }
const saved = { toolInputJson: '{"region":"west"}', toolResultJson: '{"content":[{"type":"text","text":"42"}]}' }
const jsonParams = z.json()
const request = (method: string, params: z.infer<typeof jsonParams> = {}, id?: number) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

function fakeClock() {
  let now = 0
  const timers: Array<{ at: number; run: () => void; done: boolean }> = []
  const clock: McpAppClock = {
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, done: false }
      timers.push(timer)
      return () => { timer.done = true }
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers) {
      if (!timer.done && timer.at <= now) {
        timer.done = true
        timer.run()
      }
    }
  }
  return { clock, advance }
}

function live(overrides: Partial<McpAppHostOptions> = {}) {
  const posted: string[] = []
  const closed: Array<McpAppCancelReason | undefined> = []
  const { clock, advance } = fakeClock()
  const host = createMcpAppHost({
    snapshot: liveDocument, title: 'Charts', clock, context: () => context, permissions: () => [], post: (json) => posted.push(json),
    toolInfo: async (name) => ({ callable: true, readOnly: true, title: name }), callTool: async () => '{"content":[]}', readResource: async () => '{"contents":[]}',
    confirm: async () => true, sendMessage: async () => {}, updateModelContext: async () => {}, openLink: async () => {},
    displayMode: (mode) => mode, resize: () => {}, close: (reason) => { closed.push(reason) }, ...overrides,
  })
  const notifications = () => posted.map((json) => JSON.parse(json)).filter((message) => !('id' in message) || message.method === 'ui/resource-teardown')
  const ready = async () => {
    await host.receive(request('ui/initialize', {}, 1))
    await host.receive(request('ui/notifications/initialized'))
  }
  return { host, posted, closed, advance, notifications, methods: () => notifications().map((message) => message.method), ready }
}

describe('healPartialJson', () => {
  test('closes a cut string, array, and object, and drops what is not whole', () => {
    expect(healPartialJson('{"region":"we')).toEqual({ region: 'we' })
    expect(healPartialJson('{"rows":[1,2,')).toEqual({ rows: [1, 2] })
    expect(healPartialJson('{"filter":{"from":"2026')).toEqual({ filter: { from: '2026' } })
    expect(healPartialJson('[1,{"x":"y')).toEqual([1, { x: 'y' }])
  })

  test('drops a key with no value, a cut escape, and a cut number or literal', () => {
    expect(healPartialJson('{"a":1,"b')).toEqual({ a: 1 })
    expect(healPartialJson('{"a":1,"b":')).toEqual({ a: 1 })
    expect(healPartialJson('{"a":"x\\')).toEqual({ a: 'x' })
    expect(healPartialJson('{"a":"\\u00')).toEqual({ a: '' })
    expect(healPartialJson('{"a":"q\\"z')).toEqual({ a: 'q"z' })
    expect(healPartialJson('{"a":tru')).toEqual({})
    expect(healPartialJson('{"a":-')).toEqual({})
    expect(healPartialJson('{"a":12')).toEqual({ a: 12 })
  })

  test('gives nothing for empty or malformed text', () => {
    expect(healPartialJson('')).toBeUndefined()
    expect(healPartialJson('  ')).toBeUndefined()
    expect(healPartialJson('{"a" 1}')).toBeUndefined()
  })
})

describe('live app card bridge', () => {
  test('the app gets partial inputs, then the input once, then the result, in one frame', async () => {
    const s = live()
    await s.ready()
    s.host.followCall({ input: '{"region":"we', end: null })
    s.advance(MCP_APP_PARTIAL_INPUT_INTERVAL_MS)
    s.host.followCall({ input: '{"region":"west","year":20', end: null })
    s.host.followCall({ input: '{"region":"west","year":2026}', end: null })
    // A partial after the whole input is never sent.
    s.advance(MCP_APP_PARTIAL_INPUT_INTERVAL_MS)
    s.host.followCall({ input: '{"region":"west","year":2026}', end: 'completed' })
    s.host.toolResult(saved)
    expect(s.methods()).toEqual(['ui/notifications/tool-input-partial', 'ui/notifications/tool-input-partial', 'ui/notifications/tool-input', 'ui/notifications/tool-result'])
    const [first, second, input] = s.notifications()
    expect(first.params.arguments).toEqual({ region: 'we' })
    expect(second.params.arguments).toEqual({ region: 'west', year: 20 })
    expect(input.params.arguments).toEqual({ region: 'west', year: 2026 })
    expect(s.closed).toEqual([])
  })

  test('partial input reaches the app ten times a second at most, the newest last, and an equal value once', async () => {
    const s = live()
    await s.ready()
    s.host.followCall({ input: '{"q":"a', end: null })
    s.host.followCall({ input: '{"q":"ab', end: null })
    s.host.followCall({ input: '{"q":"abc', end: null })
    expect(s.methods()).toEqual(['ui/notifications/tool-input-partial'])
    s.advance(MCP_APP_PARTIAL_INPUT_INTERVAL_MS - 1)
    expect(s.methods()).toHaveLength(1)
    s.advance(1)
    expect(s.notifications().map((message) => message.params.arguments.q)).toEqual(['a', 'abc'])
    // A key that is not whole yet heals to the value the app already has.
    s.host.followCall({ input: '{"q":"abc","n', end: null })
    s.advance(MCP_APP_PARTIAL_INPUT_INTERVAL_MS * 2)
    expect(s.methods()).toHaveLength(2)
  })

  test('an app that becomes ready late gets only the newest state', async () => {
    const s = live()
    s.host.followCall({ input: '{"q":"a', end: null })
    s.host.followCall({ input: '{"q":"ab', end: null })
    expect(s.posted).toEqual([])
    await s.ready()
    expect(s.notifications().map((message) => message.params.arguments)).toEqual([{ q: 'ab' }])
  })

  test('Codex gives the input whole: the app gets the input at once and no partial', async () => {
    const s = live()
    await s.ready()
    s.host.followCall(mcpAppLiveCall({ input: '{"region":"west"}', status: 'running' }, false, true)!)
    expect(s.methods()).toEqual(['ui/notifications/tool-input'])
  })

  test('a stopped call sends tool-cancelled with its reason, then the teardown, and the card goes', async () => {
    const s = live()
    await s.ready()
    s.host.followCall({ input: '{"region":"we', end: null })
    s.host.followCall(mcpAppLiveCall({ input: '{"region":"we', status: 'error' }, true, true)!)
    expect(s.methods()).toEqual(['ui/notifications/tool-input-partial', 'ui/notifications/tool-cancelled', 'ui/resource-teardown'])
    expect(s.notifications()[1].params).toEqual({ reason: 'stopped' })
    const teardown = s.notifications()[2]
    await s.host.receive(JSON.stringify({ jsonrpc: '2.0', id: teardown.id, result: {} }))
    await Bun.sleep(0)
    expect(s.closed).toEqual(['stopped'])
    // Nothing reaches the app after the cancel.
    s.host.toolResult(saved)
    expect(s.methods()).toHaveLength(3)
  })

  test('a failed call is cancelled as failed; an app that is not ready closes at once', () => {
    const s = live()
    s.host.followCall(mcpAppLiveCall({ input: '{}', status: 'error' }, false, true)!)
    expect(s.posted).toEqual([])
    expect(s.closed).toEqual(['failed'])
  })

  test('a call that ended with no saved app within the wait is cancelled as failed', async () => {
    const s = live()
    await s.ready()
    s.host.followCall({ input: '{"q":1}', end: 'completed' })
    s.advance(MCP_APP_CAPTURE_WAIT_MS - 1)
    expect(s.methods()).toEqual(['ui/notifications/tool-input'])
    s.advance(1)
    expect(s.methods()).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-cancelled', 'ui/resource-teardown'])
    expect(s.notifications()[1].params).toEqual({ reason: 'failed' })
  })

  test('the saved app in time keeps the card, and the result comes after the input even when the input never streamed', async () => {
    const s = live()
    await s.ready()
    s.host.followCall({ input: '{"region":"we', end: null })
    s.host.followCall({ input: '{"region":"we', end: 'completed' })
    s.host.toolResult(saved)
    s.advance(MCP_APP_CAPTURE_WAIT_MS * 2)
    expect(s.methods()).toEqual(['ui/notifications/tool-input-partial', 'ui/notifications/tool-input', 'ui/notifications/tool-result'])
    expect(s.notifications()[1].params.arguments).toEqual({ region: 'west' })
  })

  test('a reconnect during the call brings the card level with the transcript', async () => {
    // A client that reconnects reads the turn again: the same row now has the
    // whole input, or the call already ended.
    const running = live()
    await running.ready()
    running.host.followCall({ input: '{"region":"we', end: null })
    running.host.followCall({ input: '{"region":"west"}', end: null })
    running.host.followCall({ input: '{"region":"west"}', end: null })
    expect(running.methods()).toEqual(['ui/notifications/tool-input-partial', 'ui/notifications/tool-input'])
    const ended = live()
    await ended.ready()
    ended.host.followCall({ input: '{"region":"we', end: null })
    ended.host.followCall(mcpAppLiveCall({ input: '{"region":"west"}', status: 'error' }, false, true)!)
    expect(ended.methods()).toEqual(['ui/notifications/tool-input-partial', 'ui/notifications/tool-input', 'ui/notifications/tool-cancelled', 'ui/resource-teardown'])
  })

  test('before the result the app cannot call a tool, read a resource, or give the agent context', async () => {
    const called: string[] = []
    const s = live({ callTool: async (name) => { called.push(name); return '{}' }, updateModelContext: async (text) => { called.push(text) } })
    await s.ready()
    await s.host.receive(request('tools/call', { name: 'refresh', arguments: {} }, 2))
    await s.host.receive(request('resources/read', { uri: 'ui://chart/data' }, 3))
    await s.host.receive(request('ui/update-model-context', { content: [{ type: 'text', text: 'west' }] }, 4))
    const errors = s.posted.map((json) => JSON.parse(json)).filter((message) => message.error).map((message) => message.error.message)
    expect(errors).toEqual(['The tool call has not ended.', 'The tool call has not ended.', 'The tool call has not ended.'])
    expect(called).toEqual([])
    s.host.toolResult(saved)
    await s.host.receive(request('tools/call', { name: 'refresh', arguments: {} }, 5))
    expect(called).toEqual(['refresh'])
  })

  test('a saved app gives its frame no live notifications', async () => {
    const s = live({ snapshot: { ...liveDocument, ...saved } })
    await s.ready()
    s.host.followCall({ input: '{"region":"e', end: null })
    s.host.followCall({ input: '{}', end: 'failed' })
    expect(s.methods()).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
    expect(s.closed).toEqual([])
  })
})

describe('live app card state', () => {
  test('a hidden conversation gives its card nothing while the call runs, and the end in any case', () => {
    expect(mcpAppLiveCall({ input: '{"q":"a', status: 'running' }, false, false)).toBeNull()
    expect(mcpAppLiveCall({ input: '{"q":"a', status: 'running' }, false, true)).toEqual({ input: '{"q":"a', end: null })
    expect(mcpAppLiveCall({ input: '{"q":"a"}', status: 'completed' }, false, false)).toEqual({ input: '{"q":"a"}', end: 'completed' })
    expect(mcpAppLiveCall({ input: '', status: 'error' }, false, false)?.end).toBe('failed')
    expect(mcpAppLiveCall({ input: '', status: 'running' }, true, false)?.end).toBe('stopped')
  })

  test('only a Solus integration tool can have a live card, from both providers', () => {
    expect(mcpAppLiveToolName('mcp__solus__charts__chart')).toBe('charts__chart')
    expect(mcpAppLiveToolName('solus.charts__chart')).toBe('charts__chart')
    expect(mcpAppLiveToolName('mcp__solus__create_work')).toBeNull()
    expect(mcpAppLiveToolName('mcp__linear__create_issue')).toBeNull()
    expect(mcpAppLiveToolName('Bash')).toBeNull()
  })

  test('the host is asked once for each tool, a null too; a failed read is asked again', async () => {
    let asked = 0
    let fails = true
    const cards = new McpAppLiveCards({
      mcpAppLiveRead: async ({ toolName }) => {
        asked++
        if (toolName === 'flaky__x' && fails) throw new Error('offline')
        return toolName === 'charts__chart' ? liveDocument : null
      },
    })
    expect(await cards.document({ sessionId: 's', toolName: 'charts__chart' })).toEqual(liveDocument)
    expect(await cards.document({ sessionId: 's', toolName: 'charts__chart' })).toEqual(liveDocument)
    expect(await cards.document({ sessionId: 's', toolName: 'plain__echo' })).toBeNull()
    expect(await cards.document({ sessionId: 's', toolName: 'plain__echo' })).toBeNull()
    expect(asked).toBe(2)
    expect(await cards.document({ sessionId: 's', toolName: 'flaky__x' })).toBeNull()
    fails = false
    await cards.document({ sessionId: 's', toolName: 'flaky__x' })
    expect(asked).toBe(4)
  })

  test('a mounted live card holds its call: the saved card hands it the activity and stays hidden until the release', () => {
    const cards = new McpAppLiveCards({ mcpAppLiveRead: async () => null })
    const adopted: string[] = []
    let changes = 0
    cards.subscribe(() => changes++)
    expect(cards.isHeld('s', 'toolu_1')).toBe(false)
    const release = cards.hold('s', 'toolu_1', (activityId) => adopted.push(activityId))
    expect(cards.isHeld('s', 'toolu_1')).toBe(true)
    expect(cards.isHeld('other', 'toolu_1')).toBe(false)
    cards.handOver('s', 'toolu_1', 'activity-1')
    expect(adopted).toEqual(['activity-1'])
    release()
    expect(cards.isHeld('s', 'toolu_1')).toBe(false)
    expect(cards.isHeld('s', undefined)).toBe(false)
    expect(changes).toBe(2)
  })
})
