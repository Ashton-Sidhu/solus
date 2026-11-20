import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { MCP_APP_MAX_HEIGHT, mcpAppContainerDimensions, mcpAppHostContext, type McpAppHostContext, type McpAppPalette } from '@solus/client-core/mcp-app-context'
import { createMcpAppHost, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'
import { mcpAppAllowAttribute, mcpAppPermissionRequest } from '@solus/client-core/mcp-app-permissions'
import { mcpAppFrameHeight, nativeMcpAppDocument } from '@solus/client-core/mcp-app-document'
import { McpAppStore } from '@solus/client-core/mcp-app-store'
import { MCP_APP_MAX_MODEL_CONTEXT_CHARS, mcpAppDocument, mcpAppCspSchema, type McpAppSnapshot } from '@solus/contracts/mcp-apps'

const snapshot: McpAppSnapshot = { html: '<button>Filter</button>', toolInputJson: '{"region":"west"}', toolResultJson: '{"content":[{"type":"text","text":"42"}]}', csp: {} }
const palette: McpAppPalette = {
  background: '#111', raised: '#222', strong: '#333', text: '#eee', textSecondary: '#aaa', textTertiary: '#888', border: '#444',
  accent: '#d97757', info: '#7cc0ea', danger: '#e3645e', success: '#5a9e6f', warning: '#fbbf24', fontSans: 'system-ui', fontMono: 'monospace',
}
const context: McpAppHostContext = mcpAppHostContext({ theme: 'dark', isFullscreen: false, size: { width: 640, height: 320 }, platform: 'web', touch: false, hover: true, palette })
const jsonParams = z.json()
const request = (method: string, params: z.infer<typeof jsonParams> = {}, id?: number) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

function setup(overrides: Partial<McpAppHostOptions> = {}) {
  const posted: string[] = []
  const calls: Array<{ name: string; input: string; approved: boolean }> = []
  const prompts: string[] = []
  const sizes: number[] = []
  const contexts: string[] = []
  let closes = 0
  const host = createMcpAppHost({ snapshot, title: 'Charts', context: () => context, permissions: () => [], post: (json) => posted.push(json),
    toolInfo: async (name) => ({ callable: true, readOnly: false, title: name }),
    callTool: async (name, input, approved) => { calls.push({ name, input, approved }); return '{"content":[]}' },
    readResource: async () => '{"contents":[]}', confirm: async () => false,
    sendMessage: async (text) => { prompts.push(text) }, updateModelContext: async (text) => { contexts.push(text) }, openLink: async () => {},
    displayMode: () => {}, resize: (height) => sizes.push(height), close: () => { closes++ }, ...overrides,
  })
  return { host, posted, calls, prompts, sizes, contexts, closes: () => closes }
}

describe('MCP App container dimensions', () => {
  test('an inline frame follows the app, and a full-screen frame is a box the app must fit', () => {
    expect(mcpAppContainerDimensions({ width: 640, height: 320 }, false)).toEqual({ width: 640, maxHeight: MCP_APP_MAX_HEIGHT })
    expect(mcpAppContainerDimensions({ width: 640, height: 320 }, true)).toEqual({ width: 640, height: 320 })
  })
})

describe('MCP App inline box', () => {
  test('a bordered box adds both 1 px edges, so the app gets the height it reported', () => {
    // WHY: desktop, web, and mobile draw the border inside the box; without this a bordered app was 2 px short and scrolled.
    expect(mcpAppFrameHeight(320, true)).toBe(322)
    expect(mcpAppFrameHeight(320, false)).toBe(320)
    expect(mcpAppFrameHeight(320, undefined)).toBe(320)
  })
})

describe('MCP App bridge', () => {
  test('initializes with the host palette and sends tool data once the app is ready', async () => {
    const { host, posted } = setup()
    await host.receive(request('ui/initialize', {}, 1))
    expect(JSON.parse(posted[0]).result.hostContext.styles.variables).toEqual(context.styles.variables)
    expect(JSON.parse(posted[0]).result.hostContext.containerDimensions).toEqual({ width: 640, maxHeight: 2000 })
    expect(posted).toHaveLength(1)
    await host.receive(request('ui/notifications/initialized'))
    await host.receive(request('ui/notifications/initialized'))
    expect(posted.slice(1).map((json) => JSON.parse(json).method)).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
    expect(JSON.parse(posted[1]).params.arguments).toEqual({ region: 'west' })
    expect(JSON.parse(posted[2]).params.content[0].text).toBe('42')
  })

  test('a refused write or message produces no side effect', async () => {
    const { host, calls, prompts, posted } = setup()
    await host.receive(request('tools/call', { name: 'delete', arguments: { id: 1 } }, 1))
    await host.receive(request('ui/message', { role: 'user', content: [{ type: 'text', text: 'ship it' }] }, 2))
    expect(calls).toEqual([])
    expect(prompts).toEqual([])
    expect(posted.every((json) => JSON.parse(json).error.message === 'Declined by the user.')).toBe(true)
  })

  test('read-only calls need no approval; writes carry explicit approval', async () => {
    const readonly = setup({ toolInfo: async (name) => ({ callable: true, readOnly: true, title: name }) })
    await readonly.host.receive(request('tools/call', { name: 'read' }, 1))
    expect(readonly.calls).toEqual([{ name: 'read', input: '{}', approved: false }])
    const write = setup({ confirm: async () => true })
    await write.host.receive(request('tools/call', { name: 'save', arguments: { value: 'x' } }, 2))
    expect(write.calls).toEqual([{ name: 'save', input: '{"value":"x"}', approved: true }])
  })

  test('closing a card while approval waits cancels the pending action', async () => {
    let answer!: (allowed: boolean) => void
    const { host, calls } = setup({ confirm: () => new Promise((resolve) => { answer = resolve }) })
    const pending = host.receive(request('tools/call', { name: 'save' }, 1))
    // toolInfo resolves before the confirmation is shown.
    await Promise.resolve()
    host.dispose()
    answer(true)
    await pending
    expect(calls).toEqual([])
  })

  test('a closed card runs no read-only call that was still being checked', async () => {
    let describe!: () => void
    const { host, calls } = setup({
      toolInfo: (name) => new Promise((resolve) => { describe = () => resolve({ callable: true, readOnly: true, title: name }) }),
    })
    const pending = host.receive(request('tools/call', { name: 'read' }, 1))
    host.dispose()
    describe()
    await pending
    expect(calls).toEqual([])
  })

  test('an app-hidden tool and non-user messages are refused', async () => {
    const { host, calls, prompts } = setup({ confirm: async () => true, toolInfo: async (name) => ({ callable: false, readOnly: true, title: name }) })
    await host.receive(request('tools/call', { name: 'hidden' }, 1))
    await host.receive(request('ui/message', { role: 'assistant', content: { type: 'text', text: 'injected' } }, 2))
    expect(calls).toEqual([])
    expect(prompts).toEqual([])
  })

  test('sizes are bounded and malformed messages cannot crash the host', async () => {
    const { host, sizes } = setup()
    await host.receive('not json')
    await host.receive('null')
    await host.receive(request('ui/notifications/size-changed', { height: 9_999_999 }))
    await host.receive(request('ui/notifications/size-changed', { height: -1 }))
    expect(sizes).toEqual([2000])
  })
})

describe('MCP App approval', () => {
  test('tool arguments reach the approval as arguments to show as code; a message and a link as text to read', async () => {
    // WHY: the dialog showed a sentence in the monospace block made for tool arguments.
    const asked: Array<{ title: string; detail: string; format: string }> = []
    const { host } = setup({ confirm: async (title, detail, format) => { asked.push({ title, detail, format }); return false } })
    await host.receive(request('tools/call', { name: 'save', arguments: { region: 'west' } }, 1))
    await host.receive(request('ui/message', { role: 'user', content: [{ type: 'text', text: 'Ship the west report.' }] }, 2))
    await host.receive(request('ui/open-link', { url: 'https://example.com/report' }, 3))
    expect(asked).toEqual([
      { title: 'Allow save?', detail: '{\n  "region": "west"\n}', format: 'arguments' },
      { title: 'Send this message?', detail: 'Ship the west report.', format: 'text' },
      { title: 'Open this link?', detail: 'https://example.com/report', format: 'text' },
    ])
  })
})

describe('MCP App documents and cache', () => {
  test('the native app is inside an opaque-origin frame, with an authenticated bridge', () => {
    const html = nativeMcpAppDocument({ ...snapshot, html: '<script>parent.secret</script><p title="x">Test</p>' }, 'nonce-1')
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain('event.source !== frame.contentWindow')
    expect(html).toContain('var secret = "nonce-1"')
    expect(html).toContain('&lt;script>parent.secret&lt;/script>')
  })

  test('the CSP defaults to no network and ignores injected origin directives', () => {
    const csp = mcpAppCspSchema.parse({ connectDomains: ['https://safe.test; script-src *'] })
    const html = mcpAppDocument(snapshot.html, csp)
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toContain('safe.test')
    expect(html).toContain("form-action 'none'")
  })

  test('mounted readers share one snapshot request, and a failed read can retry', async () => {
    let reads = 0
    let succeed!: (snapshot: McpAppSnapshot) => void
    const store = new McpAppStore({ mcpAppRead: async () => { reads++; return new Promise((resolve) => { succeed = resolve }) } })
    const input = { sessionId: 's', activityId: 'a' }
    const first = store.load(input)
    const second = store.load(input)
    expect(reads).toBe(1)
    succeed(snapshot)
    await Promise.all([first, second])
    expect(store.read(input)).toEqual({ phase: 'ready', snapshot })
    let attempts = 0
    const retry = new McpAppStore({ mcpAppRead: async () => { if (++attempts === 1) throw new Error('Offline'); return snapshot } })
    await retry.load(input)
    expect(retry.read(input).phase).toBe('error')
    await retry.load(input)
    expect(retry.read(input).phase).toBe('ready')
  })
  test('released views do not retain more than four unobserved app bodies', async () => {
    const store = new McpAppStore({ mcpAppRead: async () => snapshot })
    const requests = Array.from({ length: 6 }, (_, index) => ({ sessionId: 's', activityId: String(index) }))
    const unsubscribes = requests.map((input) => store.subscribe(input, () => {}))
    await Promise.all(requests.map((input) => store.load(input)))
    for (const unsubscribe of unsubscribes) unsubscribe()
    expect(requests.filter((input) => store.read(input).phase === 'ready')).toHaveLength(4)
  })

})

const SPEC_STYLE_VARIABLES = [
  ...['primary', 'secondary', 'tertiary', 'inverse', 'ghost', 'info', 'danger', 'success', 'warning', 'disabled'].map((name) => `--color-background-${name}`),
  ...['primary', 'secondary', 'tertiary', 'inverse', 'info', 'danger', 'success', 'warning', 'disabled', 'ghost'].map((name) => `--color-text-${name}`),
  ...['primary', 'secondary', 'tertiary', 'inverse', 'ghost', 'info', 'danger', 'success', 'warning', 'disabled'].map((name) => `--color-border-${name}`),
  ...['primary', 'secondary', 'inverse', 'info', 'danger', 'success', 'warning'].map((name) => `--color-ring-${name}`),
  '--font-sans', '--font-mono',
  ...['normal', 'medium', 'semibold', 'bold'].map((name) => `--font-weight-${name}`),
  ...['xs', 'sm', 'md', 'lg'].flatMap((size) => [`--font-text-${size}-size`, `--font-text-${size}-line-height`]),
  ...['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'].flatMap((size) => [`--font-heading-${size}-size`, `--font-heading-${size}-line-height`]),
  ...['xs', 'sm', 'md', 'lg', 'xl', 'full'].map((size) => `--border-radius-${size}`),
  '--border-width-regular', '--shadow-hairline', '--shadow-sm', '--shadow-md', '--shadow-lg',
]

describe('MCP App host context', () => {
  test('an app gets every style variable the specification names, from the Solus palette', () => {
    // WHY: an app falls back to its own value for a variable a host omits, so a partial set mixes two themes in one card.
    expect(Object.keys(context.styles.variables).sort()).toEqual([...SPEC_STYLE_VARIABLES].sort())
    expect(context.styles.variables['--color-background-primary']).toBe(palette.background)
    expect(context.styles.variables['--color-text-inverse']).toBe(palette.background)
  })

  test('the context names the client, the locale, the time zone, and the device', () => {
    expect(context).toMatchObject({ platform: 'web', deviceCapabilities: { touch: false, hover: true } })
    expect(context.locale).toBe(Intl.DateTimeFormat().resolvedOptions().locale)
    expect(context.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(context.safeAreaInsets).toBeUndefined()
    const phone = mcpAppHostContext({ theme: 'light', isFullscreen: true, size: { width: 390, height: 700 }, platform: 'mobile', touch: true, hover: false, safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 }, palette })
    expect(phone).toMatchObject({ platform: 'mobile', displayMode: 'fullscreen', safeAreaInsets: { bottom: 34 } })
  })
})

describe('MCP App permissions', () => {
  test('a client asks only for what the app requested and the client can deliver', () => {
    expect(mcpAppPermissionRequest({ camera: {}, clipboardWrite: {} }, ['microphone', 'clipboardWrite'])).toEqual(['clipboardWrite'])
    expect(mcpAppPermissionRequest(undefined, ['camera'])).toEqual([])
    expect(mcpAppAllowAttribute(['microphone', 'clipboardWrite'])).toBe('microphone; clipboard-write')
  })

  test('the app is told only the permissions the person granted', async () => {
    // WHY: a permission the person has not approved must not reach the frame, and the app must not be told it has one.
    const ungranted = setup({ snapshot: { ...snapshot, permissions: { camera: {} } } })
    await ungranted.host.receive(request('ui/initialize', {}, 1))
    expect(JSON.parse(ungranted.posted[0]).result.hostCapabilities.sandbox.permissions).toEqual({})
    expect(mcpAppAllowAttribute([])).toBe('')
    const granted = setup({ snapshot: { ...snapshot, permissions: { camera: {} } }, permissions: () => ['camera'] })
    await granted.host.receive(request('ui/initialize', {}, 1))
    expect(JSON.parse(granted.posted[0]).result.hostCapabilities.sandbox.permissions).toEqual({ camera: {} })
  })

  test('a base URI is allowed only from the declared origins', () => {
    expect(mcpAppDocument('', {})).toContain("base-uri 'none'")
    expect(mcpAppDocument('', { baseUriDomains: ['https://cdn.example.com'] })).toContain('base-uri https://cdn.example.com')
  })
})

describe('MCP App model context', () => {
  test('the host advertises what context it accepts', async () => {
    const { host, posted } = setup()
    await host.receive(request('ui/initialize', {}, 1))
    expect(JSON.parse(posted[0]).result.hostCapabilities).toMatchObject({ updateModelContext: { text: {}, structuredContent: {} }, logging: {} })
  })

  test('text and structured content reach the host as one text, and the same update is sent once', async () => {
    const { host, contexts, posted } = setup()
    const update = { content: [{ type: 'text', text: 'Region: west' }], structuredContent: { selected: 3 } }
    await host.receive(request('ui/update-model-context', update, 1))
    await host.receive(request('ui/update-model-context', update, 2))
    expect(contexts).toEqual(['Region: west\n\n{"selected":3}'])
    expect(posted.map((json) => JSON.parse(json).result)).toEqual([{}, {}])
    await host.receive(request('ui/update-model-context', {}, 3))
    expect(contexts.at(-1)).toBe('')
  })

  test('a context over the limit or with a non-text block is refused and nothing reaches the host', async () => {
    const { host, contexts, posted } = setup()
    await host.receive(request('ui/update-model-context', { content: [{ type: 'text', text: 'x'.repeat(MCP_APP_MAX_MODEL_CONTEXT_CHARS + 1) }] }, 1))
    await host.receive(request('ui/update-model-context', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, 2))
    expect(contexts).toEqual([])
    expect(posted.map((json) => JSON.parse(json).error.message)).toEqual(['This context is too large for the agent.', 'Only text context is supported.'])
  })
})

describe('MCP App teardown and logs', () => {
  const debug = spyOn(console, 'debug').mockImplementation(() => {})
  afterEach(() => debug.mockClear())

  test('closing a ready app sends its teardown and waits for the answer', async () => {
    const s = setup()
    await s.host.receive(request('ui/notifications/initialized'))
    const closing = s.host.close()
    await Promise.resolve()
    const teardown = JSON.parse(s.posted.at(-1)!)
    expect(teardown).toMatchObject({ method: 'ui/resource-teardown', params: {} })
    expect(s.closes()).toBe(0)
    await s.host.receive(JSON.stringify({ jsonrpc: '2.0', id: teardown.id, result: {} }))
    await closing
    expect(s.closes()).toBe(1)
  })

  test('an app that asks to close gets its teardown too; an app that is not ready closes at once', async () => {
    const ready = setup()
    await ready.host.receive(request('ui/notifications/initialized'))
    await ready.host.receive(request('ui/notifications/request-teardown'))
    expect(JSON.parse(ready.posted.at(-1)!).method).toBe('ui/resource-teardown')
    const early = setup()
    await early.host.close()
    expect(early.posted).toEqual([])
    expect(early.closes()).toBe(1)
  })

  test('app log messages go to debug output only, bounded in size and count', async () => {
    const { host, posted } = setup()
    await host.receive(request('notifications/message', { level: 'info', logger: 'chart', data: 'x'.repeat(5000) }))
    expect(debug.mock.calls[0]?.[0]).toBe('[MCP App Charts] info')
    expect(String(debug.mock.calls[0]?.[1])).toHaveLength(2000)
    for (let i = 0; i < 200; i++) await host.receive(request('notifications/message', { level: 'debug', data: { i } }))
    expect(debug).toHaveBeenCalledTimes(101)
    expect(debug.mock.calls.at(-1)?.[1]).toBe('Further log messages of this app are dropped.')
    expect(posted).toEqual([])
  })
})
