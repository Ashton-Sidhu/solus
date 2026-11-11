import { describe, expect, test } from 'bun:test'
import { describeAppPermissions, parseAppToolName } from '@solus/contracts/apps'
import { AppCompileError, appSourceProblem, compileAppComponent, extractAppRoles } from '@solus/server/apps/app-source'
import { composeAppDocument } from '@solus/server/apps/app-shell'
import { admits } from '@solus/server/apps/app-permissions'
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
      compiledComponent: 'exports.default = () => "</script><b>x</b>"',
      roles: [{ slug: 'linear', name: 'Linear', connected: false }],
      permissions: { tools: 'read-only', writes: 'ask' },
    })
    expect(html).toContain('<script>window.SolusAppShell = {}</script>')
    expect(html).toContain('SolusAppShell.define(function(require,module,exports){')
    expect(html).not.toContain('"</script><b>')
    expect(html).toContain('<\\/script>')
    expect(html).toContain('SolusAppShell.mount({"roles":[{"slug":"linear","name":"Linear","connected":false}],"permissions":{"tools":"read-only","writes":"ask"}})')
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
    expect(admits({ tools: 'all', writes: 'ask' }, 'x/create', write)).toBe(true)
    expect(admits({ tools: 'read-only', writes: 'ask' }, 'x/list', read)).toBe(true)
    expect(admits({ tools: 'read-only', writes: 'ask' }, 'x/create', write)).toBe(false)
    expect(admits({ tools: 'read-only', writes: 'ask' }, 'x/gone', undefined)).toBe(false)
    expect(admits({ tools: { selected: ['x/create'] }, writes: 'ask' }, 'x/create', write)).toBe(true)
    expect(admits({ tools: { selected: ['x/create'] }, writes: 'ask' }, 'x/list', read)).toBe(false)
  })

  test('a wire name is the slug and the tool, and the permissions read back as one line for a header', () => {
    expect(parseAppToolName('linear/list_issues')).toEqual({ slug: 'linear', tool: 'list_issues' })
    expect(parseAppToolName('linear/issues.list')).toEqual({ slug: 'linear', tool: 'issues.list' })
    expect(parseAppToolName('linear')).toBeNull()
    expect(parseAppToolName('/list')).toBeNull()
    expect(describeAppPermissions({ tools: 'all', writes: 'ask' })).toBe('All tools · writes ask first')
    expect(describeAppPermissions({ tools: { selected: ['a/b'] }, writes: 'allow' })).toBe('1 selected tools · writes run on click')
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
