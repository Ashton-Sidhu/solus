import { describe, expect, test } from 'bun:test'
import { appPermissionsSchema, DEFAULT_APP_PERMISSIONS, describeAppHostAccess, describeAppPermissions, parseAppCallName, type AppHostAccess } from '@solus/contracts/apps'
import { mcpAppDocument } from '@solus/contracts/mcp-apps'
import { AppCompileError, appSourceProblem, compileAppComponent, extractAppRoles } from '@solus/server/apps/app-source'
import { appClientModule, appContentProblem, appRoles, appServerModule, describeAppContent, readAppContent } from '@solus/server/apps/app-content'
import { composeAppDocument } from '@solus/server/apps/app-shell'
import { admits, appConnectDomains, hostAccessAsked, hostAccessCovers, hostAccessIsEmpty } from '@solus/server/apps/app-permissions'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'

const COMPONENT = `
import { useQuery } from '@tanstack/react-query'
import { tools, Card } from '@solus/app'

export default function Issues() {
  const issues = useQuery(tools.linear.list_issues.queryOptions({ team: 'ENG' }))
  // tools.github.create_issue is not called: a comment never binds a role
  return <Card>{issues.data?.length ?? 0} issues · {tools["slack"].post_message ? 'can post' : ''}</Card>
}
`

describe('app source', () => {
  test('roles are the integration slugs the code reaches through tools, first use first, comments ignored', () => {
    // WHY: a role binds to the viewer's own integration on every call. A slug
    // in a comment would ask the viewer to connect a service the app never uses.
    expect(extractAppRoles(COMPONENT)).toEqual(['linear', 'slack'])
  })

  test('the compiled component imports through require and renders JSX with the automatic runtime', () => {
    // WHY: the frame's policy has no unsafe-eval and no network, so the shell's
    // require is the component's whole module space.
    const output = compileAppComponent(COMPONENT)
    expect(output).toContain("require('@tanstack/react-query')")
    expect(output).toContain("require('@solus/app')")
    expect(output).toContain('react/jsx-runtime')
    expect(output).not.toContain('import ')
    // Memoized: the same source is the same string, not a second transform.
    expect(compileAppComponent(COMPONENT)).toBe(output)
  })

  test('a syntax error and a missing default export are refused before a save', () => {
    // WHY: every write of an `app` work passes here, so a broken component
    // reaches the agent as the tool result instead of a blank frame.
    expect(() => compileAppComponent('export default function A() { return <div> }')).toThrow(AppCompileError)
    expect(appSourceProblem('export default function A() { return <div> }')).toContain('does not compile')
    expect(appSourceProblem('function A() { return null }')).toContain('export default')
    expect(appSourceProblem('')).toContain('empty')
    expect(appSourceProblem(COMPONENT)).toBeNull()
  })
})

describe('app document', () => {
  test('the shell, the component, and the mount config are inline, and a script end inside the source cannot close the script', () => {
    const html = composeAppDocument({
      shell: 'window.SolusAppShell = {}',
      clientModule: 'exports.default = () => "</script><b>x</b>"',
      css: '.map{color:red}</style><b>y</b>',
      roles: [{ slug: 'linear', name: 'Linear', connected: false }],
      permissions: { ...DEFAULT_APP_PERMISSIONS, tools: 'read-only' },
      hostAccess: 'pending',
    })
    expect(html).toContain('<script>window.SolusAppShell = {}</script>')
    expect(html).toContain('SolusAppShell.define(function(require,module,exports){')
    expect(html).not.toContain('"</script><b>')
    expect(html).toContain('<\\/script>')
    expect(html).toContain('SolusAppShell.mount({"roles":[{"slug":"linear","name":"Linear","connected":false}],"permissions":{"tools":"read-only","writes":"ask","network":[],"files":{"read":[],"write":[]}},"hostAccess":"pending"})')
    // A bundle's own styles ride along, and a style end inside them cannot close the element.
    expect(html).toContain('<style id="solus-app-styles">.map{color:red}<\\/style><b>y</b></style>')
    // Both palettes ride along so the shell switches without a reload.
    expect(html).toContain(':root[data-theme=dark]{')
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

  test('a call name addresses an integration tool, the app storage, or a host function, and nothing else', () => {
    // WHY: the three share one message of the frame protocol. A storage or
    // function name that read as an integration tool would reach the gateway.
    expect(parseAppCallName('linear/list_issues')).toEqual({ kind: 'tool', slug: 'linear', tool: 'list_issues' })
    expect(parseAppCallName('linear/issues.list')).toEqual({ kind: 'tool', slug: 'linear', tool: 'issues.list' })
    expect(parseAppCallName('@storage/set')).toEqual({ kind: 'storage', operation: 'set' })
    expect(parseAppCallName('@server/tables')).toEqual({ kind: 'function', name: 'tables' })
    expect(parseAppCallName('@storage/drop')).toBeNull()
    expect(parseAppCallName('@other/x')).toBeNull()
    expect(parseAppCallName('linear')).toBeNull()
    expect(parseAppCallName('/list')).toBeNull()
  })

  test('the permissions read back as one line for a header, and permissions of the first release read as the default', () => {
    expect(describeAppPermissions({ tools: 'all', writes: 'ask' })).toBe('All tools · writes ask first')
    expect(describeAppPermissions({ tools: { selected: ['a/b'] }, writes: 'allow' })).toBe('1 selected tools · writes run on click')
    // WHY: meta written before the general model has no network and no files; it must not fail to parse or gain access.
    expect(appPermissionsSchema.parse({ tools: 'read-only', writes: 'ask' })).toEqual({ ...DEFAULT_APP_PERMISSIONS, tools: 'read-only' })
    // A selected list holds integration tools only: a reserved name is not one.
    expect(appPermissionsSchema.safeParse({ tools: { selected: ['@server/x'] } }).success).toBe(false)
    expect(appPermissionsSchema.safeParse({ network: ['https://api.example.com'] }).success).toBe(false)
    expect(appPermissionsSchema.safeParse({ files: { read: ['relative/path'] } }).success).toBe(false)
  })
})

const BUNDLE = {
  solusApp: 1,
  client: 'exports.default = function App() { return null }',
  css: '.a{}',
  server: 'exports.tables = async () => []',
  integrations: ['linear'],
  sources: { 'src/App.tsx': 'export default function App() { return null }', 'server.ts': 'export async function tables() { return [] }' },
}

describe('app content', () => {
  test('a bundle is a JSON object that says so; every other body is a component', () => {
    // WHY: the content alone says which form it is, so a write through any
    // door (create_app, update_work, a restore) is checked the same way.
    const bundle = readAppContent(JSON.stringify(BUNDLE))
    expect(bundle.kind).toBe('bundle')
    expect(appRoles(bundle)).toEqual(['linear'])
    expect(appClientModule(bundle)).toBe(BUNDLE.client)
    expect(appServerModule(bundle)).toBe(BUNDLE.server)

    const component = readAppContent(COMPONENT)
    expect(component.kind).toBe('component')
    expect(appRoles(component)).toEqual(['linear', 'slack'])
    expect(appClientModule(component)).toContain("require('@solus/app')")
    expect(appServerModule(component)).toBeNull()
  })

  test('a body that says it is a bundle and is not a valid one is refused with the field that is wrong', () => {
    expect(appContentProblem(JSON.stringify({ solusApp: 1, integrations: [] }))).toContain('client')
    expect(appContentProblem(JSON.stringify({ solusApp: 2, client: 'x' }))).toContain('solusApp')
    expect(appContentProblem(JSON.stringify(BUNDLE))).toBeNull()
    expect(appContentProblem(COMPONENT)).toBeNull()
    // JSON that does not say it is a bundle is read as a component, and fails as one.
    expect(appContentProblem('{"client":"x"}')).toContain('export default')
  })

  test('an agent reads a bundle as its sources, never as its compiled code', () => {
    // WHY: read_work puts the answer in the agent's context. A bundle is megabytes of compiled code.
    const text = describeAppContent(JSON.stringify({ ...BUNDLE, client: `/*compiled*/${'x'.repeat(5000)}` }))
    expect(text).toContain('--- src/App.tsx ---\nexport default function App()')
    expect(text).toContain('--- server.ts ---')
    expect(text).toContain('integrations linear')
    expect(text).not.toContain('/*compiled*/')
    expect(describeAppContent(JSON.stringify({ ...BUNDLE, sources: undefined }))).toContain('carries no sources')
    expect(describeAppContent(COMPONENT)).toBe(COMPONENT)
  })
})

describe('app host access', () => {
  const asks = (access: Partial<AppHostAccess>): AppHostAccess => ({ functions: false, network: [], files: { read: [], write: [] }, ...access })

  test('an app asks for host functions when its bundle has a server module, and file paths mean nothing without them', () => {
    const permissions = { network: ['api.example.com'], files: { read: ['~/data'], write: [] } }
    expect(hostAccessAsked(permissions, true)).toEqual({ functions: true, network: ['api.example.com'], files: { read: ['~/data'], write: [] } })
    expect(hostAccessAsked(permissions, false)).toEqual({ functions: false, network: ['api.example.com'], files: { read: [], write: [] } })
    expect(hostAccessIsEmpty(hostAccessAsked(DEFAULT_APP_PERMISSIONS, false))).toBe(true)
    expect(hostAccessIsEmpty(hostAccessAsked(DEFAULT_APP_PERMISSIONS, true))).toBe(false)
  })

  test('a wider request asks the owner again; a narrower one does not', () => {
    // WHY: the owner allowed a set of things once. An agent's revision must
    // not gain a host, a path, or code on the host under that old decision.
    const allowed = asks({ functions: true, network: ['api.example.com'], files: { read: ['~/data'], write: [] } })
    expect(hostAccessCovers(allowed, allowed)).toBe(true)
    expect(hostAccessCovers(allowed, asks({ functions: true }))).toBe(true)
    expect(hostAccessCovers(allowed, asks({ functions: true, network: ['api.example.com', 'evil.example.com'] }))).toBe(false)
    expect(hostAccessCovers(allowed, asks({ functions: true, files: { read: ['~/data'], write: ['~/data'] } }))).toBe(false)
    expect(hostAccessCovers(asks({ network: ['api.example.com'] }), asks({ functions: true, network: ['api.example.com'] }))).toBe(false)
    expect(hostAccessCovers(asks({ network: ['*'] }), asks({ network: ['anything.example.com'] }))).toBe(true)
  })

  test('the frame reaches only the allowed hosts, and no host until one is allowed', () => {
    expect(appConnectDomains(['api.example.com', '*.example.org'])).toEqual(['https://api.example.com', 'wss://api.example.com', 'https://*.example.org', 'wss://*.example.org'])
    expect(appConnectDomains(['*'])).toEqual(['https:', 'wss:'])
    expect(mcpAppDocument('', { connectDomains: appConnectDomains(['api.example.com']) })).toContain('connect-src https://api.example.com wss://api.example.com;')
    expect(mcpAppDocument('', {})).toContain("connect-src 'none'")
  })

  test('host access reads as the end of a sentence a person can decide on', () => {
    expect(describeAppHostAccess(asks({ functions: true }))).toBe('run its own code on this host')
    expect(describeAppHostAccess(asks({ network: ['api.example.com'] }))).toBe('reach api.example.com')
    expect(describeAppHostAccess(asks({ functions: true, network: ['*'], files: { read: ['*'], write: ['~/out'] } }))).toBe('run its own code on this host, read every file, write ~/out, and reach every network host')
  })
})

describe('app receipts in history', () => {
  test('a create_app receipt names the work a feed row opens, at version 1 for a new app', () => {
    // WHY: the mobile feed rebuilds its app rows from history through
    // `artifactWorkRef`; without the projection a reopened thread loses its apps.
    const [, created] = projectSessionHistory([
      { role: 'tool', toolId: 't1', toolName: 'mcp__solus__create_app', content: '' },
      { role: 'tool_result', toolResultForId: 't1', content: 'Created the app "Issues" (id: work-1). It opens from the conversation.' },
    ] as Parameters<typeof projectSessionHistory>[0])
    expect(created.artifactWorkRef).toEqual({ title: 'Issues', workId: 'work-1', contentVersion: 1 })
    const [, updated] = projectSessionHistory([
      { role: 'tool', toolId: 't2', toolName: 'create_app', content: '' },
      { role: 'tool_result', toolResultForId: 't2', content: 'Updated the app "Issues" (id: work-1). New content_version: 3.' },
    ] as Parameters<typeof projectSessionHistory>[0])
    expect(updated.artifactWorkRef).toEqual({ title: 'Issues', workId: 'work-1', contentVersion: 3 })
  })
})
