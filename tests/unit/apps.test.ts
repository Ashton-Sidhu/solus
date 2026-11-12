import { describe, expect, test } from 'bun:test'
import { answerAppCall, appCallMessageSchema, appCallValue, appResultMessage } from '@solus/client-core/app-calls'
import {
  appFunctionCallName,
  appHostAccessNotice,
  appManifestBlock,
  appManifestSchema,
  appPermissionsSchema,
  appStorageCallName,
  DEFAULT_APP_PERMISSIONS,
  describeAppHostAccess,
  hasAppManifest,
  parseAppCallName,
  readAppPage,
  type AppHostAccess,
} from '@solus/contracts/apps'
import { wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'
import { appServerHash, describeAppContent } from '@solus/server/apps/app-content'
import { admits, hostAccessAsked, hostAccessCovers, hostAccessIsEmpty, hostAccessReceiptNote, hostAccessState } from '@solus/server/apps/app-permissions'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'

const PAGE = '<!doctype html><html><head><title>Notes</title></head><body><div id="root"></div><script>render()</script></body></html>'
const manifest = (extra: object = {}) => appManifestSchema.parse({ solusApp: 1, ...extra })
const appPage = (extra: object = {}) => `${PAGE}\n${appManifestBlock(manifest(extra))}\n`

describe('the app manifest', () => {
  test('a page with a manifest block is an app; any other page is a plain artifact', () => {
    // WHY: an app is an artifact, and the page alone says which it is. The
    // server, the frame, and a save all ask this one reader, so they agree.
    expect(readAppPage(PAGE)).toEqual({ kind: 'none' })
    expect(hasAppManifest(PAGE)).toBe(false)
    const read = readAppPage(appPage({ integrations: ['linear'], server: 'exports.rows = async () => []' }))
    expect(read).toEqual({ kind: 'app', manifest: { solusApp: 1, permissions: DEFAULT_APP_PERMISSIONS, integrations: ['linear'], server: 'exports.rows = async () => []' } })
    expect(hasAppManifest(appPage())).toBe(true)
  })

  test('nothing inside the manifest can end its script element', () => {
    // WHY: host code and sources are text an agent wrote. A `</script>` in
    // them would cut the manifest short and run the rest as markup.
    const server = 'exports.page = async () => "</script><script>alert(1)</script>"'
    const page = appPage({ server, sources: { 'src/App.tsx': 'const a = 1 < 2' } })
    expect(page.split('</script>')).toHaveLength(PAGE.split('</script>').length + 1)
    expect(readAppPage(page)).toMatchObject({ kind: 'app', manifest: { server, sources: { 'src/App.tsx': 'const a = 1 < 2' } } })
  })

  test('a block that is there and is not a valid manifest is named as wrong, not read as a plain page', () => {
    // WHY: a page that says it is an app runs under the app policy. One that
    // slipped through as a plain artifact would keep an open network.
    const broken = (json: string) => `${PAGE}<script type="application/json" id="solus-app">${json}</script>`
    expect(readAppPage(broken('{"solusApp":2}'))).toMatchObject({ kind: 'invalid', problem: expect.stringContaining('solusApp') })
    expect(readAppPage(broken('{"solusApp":1,"permissions":{"network":["https://api.example.com"]}}'))).toMatchObject({ kind: 'invalid', problem: expect.stringContaining('permissions.network.0') })
    expect(readAppPage(broken('not json'))).toEqual({ kind: 'invalid', problem: 'The app manifest is not JSON.' })
    expect(hasAppManifest(broken('not json'))).toBe(true)
  })

  test('an agent reads an app as its sources, never as megabytes of built page', () => {
    // WHY: read_work puts the answer in the agent's context, and a later session rebuilds the app from it.
    const page = appPage({ integrations: ['linear'], server: 'exports.rows = 1', sources: { 'src/App.tsx': 'export default function App() { return null }', 'server.ts': 'export async function rows() { return [] }' } })
    const text = describeAppContent(page)
    expect(text).toContain('--- src/App.tsx ---\nexport default function App()')
    expect(text).toContain('--- server.ts ---')
    expect(text).toContain('integrations linear')
    expect(text).not.toContain('<div id="root">')
    expect(describeAppContent(appPage())).toContain('carries no sources')
    expect(describeAppContent(PAGE)).toBe(PAGE)
  })
})

describe('call names', () => {
  test('a call name addresses an integration tool, the app storage, or a host function, and nothing else', () => {
    // WHY: the three share one message of the frame. A storage or function
    // name that read as an integration tool would reach the gateway.
    expect(parseAppCallName('linear/list_issues')).toEqual({ kind: 'tool', slug: 'linear', tool: 'list_issues' })
    expect(parseAppCallName('linear/issues.list')).toEqual({ kind: 'tool', slug: 'linear', tool: 'issues.list' })
    expect(parseAppCallName(appStorageCallName('set'))).toEqual({ kind: 'storage', operation: 'set' })
    expect(parseAppCallName(appFunctionCallName('tables'))).toEqual({ kind: 'function', name: 'tables' })
    expect(parseAppCallName('@storage/drop')).toBeNull()
    expect(parseAppCallName('@other/x')).toBeNull()
    expect(parseAppCallName('linear')).toBeNull()
    expect(parseAppCallName('/list')).toBeNull()
  })
})

describe('app permissions', () => {
  const read = { annotations: { readOnlyHint: true } }
  const write = { annotations: {} }

  test('all admits everything, read-only admits only a tool with the read-only hint, selected admits a listed name', () => {
    // WHY: the permissions are the app's own ceiling. A tool with no read-only
    // hint may write, so read-only must refuse it.
    expect(admits({ tools: 'all' }, 'x/create', write)).toBe(true)
    expect(admits({ tools: 'read-only' }, 'x/list', read)).toBe(true)
    expect(admits({ tools: 'read-only' }, 'x/create', write)).toBe(false)
    expect(admits({ tools: 'read-only' }, 'x/gone', undefined)).toBe(false)
    expect(admits({ tools: { selected: ['x/create'] } }, 'x/create', write)).toBe(true)
    expect(admits({ tools: { selected: ['x/create'] } }, 'x/list', read)).toBe(false)
  })

  test('an empty app.json is the default, and a wrong entry is refused', () => {
    expect(appPermissionsSchema.parse({})).toEqual(DEFAULT_APP_PERMISSIONS)
    // A selected list holds integration tools only: a reserved name is not one.
    expect(appPermissionsSchema.safeParse({ tools: { selected: ['@server/x'] } }).success).toBe(false)
    expect(appPermissionsSchema.safeParse({ network: ['https://api.example.com'] }).success).toBe(false)
    expect(appPermissionsSchema.safeParse({ files: { read: ['relative/path'] } }).success).toBe(false)
  })
})

describe('app host access', () => {
  const asks = (access: Partial<AppHostAccess>): AppHostAccess => ({ functions: false, writes: false, network: [], files: { read: [], write: [] }, ...access })

  test('an app asks for host functions when it has a server module, for silent writes when it declares them, and file paths mean nothing without host functions', () => {
    const permissions = { writes: 'ask' as const, network: ['api.example.com'], files: { read: ['~/data'], write: [] } }
    expect(hostAccessAsked(permissions, true)).toEqual({ functions: true, writes: false, network: ['api.example.com'], files: { read: ['~/data'], write: [] } })
    expect(hostAccessAsked(permissions, false)).toEqual({ functions: false, writes: false, network: ['api.example.com'], files: { read: [], write: [] } })
    expect(hostAccessIsEmpty(hostAccessAsked(DEFAULT_APP_PERMISSIONS, false))).toBe(true)
    expect(hostAccessIsEmpty(hostAccessAsked(DEFAULT_APP_PERMISSIONS, true))).toBe(false)
    // WHY: an agent writes app.json. If "writes: allow" were in force as declared, an agent could
    // give its own page the right to change a person's data with no question.
    expect(hostAccessIsEmpty(hostAccessAsked({ ...DEFAULT_APP_PERMISSIONS, writes: 'allow' }, false))).toBe(false)
  })

  test('a wider request asks the owner again; a narrower one does not', () => {
    // WHY: the owner allowed a set of things once. An agent's revision must
    // not gain a host, a path, or code on the host under that old decision.
    const allowed = asks({ functions: true, network: ['api.example.com'], files: { read: ['~/data'], write: [] } })
    expect(hostAccessCovers(allowed, allowed)).toBe(true)
    expect(hostAccessCovers(allowed, asks({ functions: true }))).toBe(true)
    expect(hostAccessCovers(allowed, asks({ functions: true, network: ['api.example.com', 'evil.example.com'] }))).toBe(false)
    expect(hostAccessCovers(allowed, asks({ functions: true, files: { read: ['~/data'], write: ['~/data'] } }))).toBe(false)
    expect(hostAccessCovers(allowed, asks({ functions: true, writes: true }))).toBe(false)
    expect(hostAccessCovers(asks({ network: ['api.example.com'] }), asks({ functions: true, network: ['api.example.com'] }))).toBe(false)
    expect(hostAccessCovers(asks({ network: ['*'] }), asks({ network: ['anything.example.com'] }))).toBe(true)
  })

  test('the owner allows host code as it is: changed host code asks again, and a change of the page alone does not', () => {
    // WHY: a host function runs with the owner's files and network. If a
    // revision could put other code under an old decision, anyone who can
    // edit the app could run code as the owner.
    const withCode = asks({ functions: true, network: ['api.example.com'] })
    const allowed = { access: withCode, serverHash: 'hash-of-v1' }
    expect(hostAccessState(withCode, 'hash-of-v1', allowed)).toBe('allowed')
    expect(hostAccessState(withCode, 'hash-of-v2', allowed)).toBe('pending')
    expect(hostAccessState(withCode, 'hash-of-v1', undefined)).toBe('pending')
    const networkOnly = asks({ network: ['api.example.com'] })
    expect(hostAccessState(networkOnly, null, { access: networkOnly, serverHash: null })).toBe('allowed')
    expect(hostAccessState(asks({}), null, undefined)).toBe('none')
    expect(appServerHash(manifest({ server: 'a' }))).not.toBe(appServerHash(manifest({ server: 'b' })))
    expect(appServerHash(manifest())).toBeNull()
  })

  test('the header says what the app asks, what is in force, and who decides', () => {
    // WHY: the owner decides from this one sentence. It must say that an
    // agent wrote the code, and it must not offer a decision to a person who cannot make it.
    const view = { asks: asks({ functions: true, network: ['db.internal:5432'] }), canDecide: true }
    expect(appHostAccessNotice({ ...view, state: 'none' })).toBeNull()
    expect(appHostAccessNotice({ ...view, state: 'pending' })).toBe('This app asks to run its own code on this host and reach db.internal:5432. An agent wrote it. Until you allow it, those parts of the app do not work.')
    expect(appHostAccessNotice({ ...view, state: 'pending', canDecide: false })).toBe('This app asks to run its own code on this host and reach db.internal:5432. Only the owner of its host can allow that.')
    expect(appHostAccessNotice({ ...view, state: 'allowed' })).toBe('This app can run its own code on this host and reach db.internal:5432.')
    expect(describeAppHostAccess(asks({ functions: true, writes: true, network: ['*'], files: { read: ['*'], write: ['~/out'] } }))).toBe('run its own code on this host, read every file, write ~/out, reach every network host, and change data through your integrations without asking')
  })

  test('a receipt tells the agent when a saved page waits for the owner, and says nothing for a plain artifact', () => {
    // WHY: the agent's receipt is the only place it learns that the person must press Allow.
    expect(hostAccessReceiptNote(PAGE, undefined)).toBe('')
    expect(hostAccessReceiptNote(appPage(), undefined)).toBe('')
    const withCode = appPage({ server: 'exports.rows = 1' })
    expect(hostAccessReceiptNote(withCode, undefined)).toContain('It asks to run its own code on this host. Tell the user to allow that')
    const allowed = { access: asks({ functions: true }), serverHash: appServerHash(manifest({ server: 'exports.rows = 1' })) }
    expect(hostAccessReceiptNote(withCode, allowed)).toBe('')
    expect(hostAccessReceiptNote(appPage({ server: 'exports.rows = 2' }), allowed)).toContain('It asks to run its own code')
  })
})

describe('the app frame', () => {
  const theme = ':root{}'
  const policyOf = (document: string) => /Content-Security-Policy" content="([^"]*)"/.exec(document)?.[1] ?? ''

  test('an app has no network but the hosts in force, and a plain artifact keeps its open network', () => {
    // WHY: an app can read a person's integrations. With a plain artifact's
    // open HTTPS, its page could send what it read anywhere.
    const closed = policyOf(wrapSandboxDocument(appPage(), theme, false, { network: [] }))
    expect(closed).toContain("connect-src 'none'")
    expect(closed).not.toContain('https:')
    const some = policyOf(wrapSandboxDocument(appPage(), theme, false, { network: ['api.example.com', '*.example.org'] }))
    expect(some).toContain('connect-src https://api.example.com wss://api.example.com https://*.example.org wss://*.example.org;')
    expect(some).toContain('img-src data: blob: https://api.example.com')
    expect(policyOf(wrapSandboxDocument(appPage(), theme, false, { network: ['*'] }))).toContain('connect-src https: wss:;')
    // A host that is not a host cannot widen the policy.
    expect(policyOf(wrapSandboxDocument(appPage(), theme, false, { network: ["'unsafe-eval' *"] }))).toContain("connect-src 'none'")
    expect(policyOf(wrapSandboxDocument(PAGE, theme))).toContain('connect-src https:;')
  })

  test('an app\'s document is a window: it is laid out in standards mode, its page scrolls, and a plain render is left as it was', () => {
    // WHY: an app is an application with a shell and its own scroll regions.
    // The render document is written for a page that grows to its content and
    // never scrolls, and renders in saved works were written against it.
    const app = wrapSandboxDocument(appPage(), theme, false, { network: [] })
    expect(app.startsWith('<!doctype html>')).toBe(true)
    expect(app).toContain('<style>html{overflow:auto;scrollbar-width:thin;height:100%}body{min-height:100%}</style>')
    const render = wrapSandboxDocument(PAGE, theme)
    expect(render.startsWith('<meta charset="utf-8">')).toBe(true)
    expect(render).not.toContain('html{overflow:auto')
  })

  test('only an app frame has the bridge, and an isolated frame never has it', () => {
    expect(wrapSandboxDocument(appPage(), theme, false, { network: [] })).toContain('window.solusApp = {')
    expect(wrapSandboxDocument(PAGE, theme)).not.toContain('window.solusApp')
    expect(wrapSandboxDocument(appPage(), theme, true, { network: ['*'] })).not.toContain('window.solusApp')
    expect(policyOf(wrapSandboxDocument(appPage(), theme, true, { network: ['*'] }))).toContain("connect-src 'none'")
  })
})

describe('the host side of a call', () => {
  const host = (overrides: Partial<Parameters<typeof answerAppCall>[0]> = {}) => ({
    toolInfo: async () => ({ callable: true, readOnly: true, title: 'List issues' }),
    callTool: async () => JSON.stringify({ structuredContent: { issues: [1, 2] } }),
    confirm: async () => true,
    ...overrides,
  })

  test('a storage or host function answer is its value, and an integration answers its structured content, else its text as JSON', () => {
    expect(appCallValue('@storage/get', JSON.stringify({ structuredContent: { value: [1, 2] } }))).toEqual([1, 2])
    expect(appCallValue('@server/rows', JSON.stringify({ structuredContent: { value: null } }))).toBeNull()
    expect(appCallValue('linear/list', JSON.stringify({ structuredContent: { issues: [] } }))).toEqual({ issues: [] })
    expect(appCallValue('linear/list', JSON.stringify({ content: [{ type: 'text', text: '{"n":1}' }] }))).toEqual({ n: 1 })
    expect(appCallValue('linear/list', JSON.stringify({ content: [{ type: 'text', text: 'plain' }] }))).toBe('plain')
    expect(() => appCallValue('linear/list', JSON.stringify({ isError: true, content: [{ type: 'text', text: 'no such team' }] }))).toThrow('no such team')
  })

  test('a call that is not read-only waits for the person, and a refusal is the page\'s error', async () => {
    // WHY: a write through a person's integration is theirs to approve. The
    // page must never be able to make one by itself.
    const calls: Array<{ approved: boolean }> = []
    const write = host({ toolInfo: async () => ({ callable: true, readOnly: false, title: 'Create issue' }), callTool: async (_name, _json, approved) => { calls.push({ approved }); return '{}' } })
    await answerAppCall(write, 'github/create_issue', { title: 'x' })
    expect(calls).toEqual([{ approved: true }])
    await expect(answerAppCall({ ...write, confirm: async () => false }, 'github/create_issue', {})).rejects.toThrow('Declined by the user.')
    expect(calls).toHaveLength(1)
    await expect(answerAppCall(host({ toolInfo: async () => ({ callable: false, readOnly: false, title: 'x', refusal: 'Connect github in Settings → MCP to use this app.' }) }), 'github/x', {})).rejects.toThrow('Connect github')
    expect(await answerAppCall(host(), 'linear/list_issues', {})).toEqual({ issues: [1, 2] })
  })

  test('a page always gets an answer to a call it posted, and a message of another shape is not a call', async () => {
    expect(appCallMessageSchema.safeParse({ type: 'solus-app-call', id: 3, name: '@storage/keys' })).toMatchObject({ success: true, data: { args: {} } })
    expect(appCallMessageSchema.safeParse({ type: 'solus-artifact-height', h: 10 }).success).toBe(false)
    expect(await appResultMessage(3, Promise.resolve(['a']))).toEqual({ type: 'solus-app-result', id: 3, ok: true, value: ['a'] })
    expect(await appResultMessage(4, Promise.reject(new Error('This app waits for its host access.')))).toEqual({ type: 'solus-app-result', id: 4, ok: false, error: 'This app waits for its host access.' })
  })
})

describe('create_app in history', () => {
  test('a create_app receipt is an artifact receipt: it names the work a reopened conversation renders', () => {
    // WHY: create_app saves through the artifact tool and writes its receipt,
    // so every replay of a render is a replay of an app with no second rule.
    const [, created] = projectSessionHistory([
      { role: 'tool', toolId: 't1', toolName: 'mcp__solus__create_app', content: '' },
      { role: 'tool_result', toolResultForId: 't1', content: 'Rendered "Table browser" in the conversation and saved it as an artifact (id: work-1). Revise it with update_work; do not render a second copy. It asks to run its own code on this host.' },
    ] as Parameters<typeof projectSessionHistory>[0])
    expect(created.artifactWorkRef).toEqual({ title: 'Table browser', workId: 'work-1', contentVersion: 1 })
  })
})
