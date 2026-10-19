import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createMcpAppHost, type McpAppHostContext, type McpAppHostOptions } from '@solus/client-core/mcp-app-host'
import { nativeMcpAppDocument } from '@solus/client-core/mcp-app-document'
import { McpAppStore } from '@solus/client-core/mcp-app-store'
import { mcpAppDocument, mcpAppCspSchema, type McpAppSnapshot } from '@solus/contracts/mcp-apps'

const snapshot: McpAppSnapshot = { html: '<button>Filter</button>', toolInputJson: '{"region":"west"}', toolResultJson: '{"content":[{"type":"text","text":"42"}]}', csp: {} }
const context: McpAppHostContext = { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web', styles: { variables: {
  '--color-background-primary': '#111', '--color-background-secondary': '#222', '--color-text-primary': '#eee', '--color-text-secondary': '#aaa', '--color-border-primary': '#333', '--font-sans': 'system-ui',
} } }
const jsonParams = z.json()
const request = (method: string, params: z.infer<typeof jsonParams> = {}, id?: number) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

function setup(overrides: Partial<McpAppHostOptions> = {}) {
  const posted: string[] = []
  const calls: Array<{ name: string; input: string; approved: boolean }> = []
  const prompts: string[] = []
  const sizes: number[] = []
  const host = createMcpAppHost({ snapshot, context: () => context, post: (json) => posted.push(json),
    toolInfo: async (name) => ({ callable: true, readOnly: false, title: name }),
    callTool: async (name, input, approved) => { calls.push({ name, input, approved }); return '{"content":[]}' },
    readResource: async () => '{"contents":[]}', confirm: async () => false,
    sendMessage: async (text) => { prompts.push(text) }, openLink: async () => {},
    displayMode: () => {}, resize: (height) => sizes.push(height), close: () => {}, ...overrides,
  })
  return { host, posted, calls, prompts, sizes }
}

describe('MCP App bridge', () => {
  test('initializes with the host palette and sends tool data once the app is ready', async () => {
    const { host, posted } = setup()
    await host.receive(request('ui/initialize', {}, 1))
    expect(JSON.parse(posted[0]).result.hostContext.styles.variables).toEqual(context.styles.variables)
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
