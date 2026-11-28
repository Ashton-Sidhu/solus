import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { appOperationCallName } from '@solus/contracts/apps'
import { writeAppProject } from './helpers/app-project'
import { NOTES, REPORTS, call, describeWithNode, host, installAppsHost, owner, project, projects, service, ship, tools } from './helpers/apps-host'
import { installTestWorkspaceTools } from './helpers/workspace-tools'

installAppsHost()

describeWithNode('the agent\'s tools for apps', () => {
  test('save_app and deploy_app make the app, and deploy_app links it to the session that deployed it', async () => {
    // WHY: the app must be found from the conversation that made it (decision 19),
    // and the receipts are all the agent knows of what the save and the deploy did.
    const apps = await service()
    const uninstall = await installTestWorkspaceTools()
    const { ensureSessionRow } = await import('@solus/server/data/sessions/session-identity')
    const { readOwnSessionArtifacts } = await import('@solus/server/data/sessions/session-artifacts')
    const { readAppSessionLinks } = await import('@solus/server/data/sessions/session-links')
    const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
    await ensureSessionRow('session-1')
    // SAFETY: the tools read the working directory, the session id, and the provider of their context.
    const context = { cwd: projects, sessionId: () => 'session-1', provider: 'claude-code' } as never
    const folder = project(NOTES)

    const saved = await tools.saveAppAgentTool.execute({ path: folder, message: 'First' }, context)
    expect(saved.ok).toBe(true)
    expect(saved.text).toContain('Saved the new app "Notes" (app: notes), revision ')
    expect(saved.text).toContain('Nothing that runs changed.')
    expect(saved.text).toContain('Deploy it with deploy_app and app: "notes".')
    expect(tools.saveAppAgentTool.requiresApproval).toBe(false)
    expect(tools.deployAppAgentTool.requiresApproval).toBe(true)

    const deployed = await tools.deployAppAgentTool.execute({ app: 'notes' }, context)
    expect(deployed.text).toContain('Deployed "Notes" (app: notes, id: ')
    expect(deployed.ok).toBe(true)
    expect(deployed.text).toContain('as version 1. It is active and linked to this session.')
    expect(deployed.text).toContain('This app runs its own code on this host.')
    expect(deployed.text).toContain('Not set: token.')
    expect(deployed.text).toContain('Its operations are tools named notes__<operation> from the next turn.')

    const [app] = await apps.list(owner)
    expect(await readOwnSessionArtifacts(ANY_ORGANIZATION, 'session-1')).toEqual([expect.objectContaining({ kind: 'app', appId: app?.id, slug: 'notes', title: 'Notes', hostId: 'test-host' })])
    expect((await readAppSessionLinks(app?.id ?? '')).map((link) => link.sessionId)).toEqual(['session-1'])

    // A folder that is not an app project is refused with what to do, and a version that fails says which version still runs.
    expect((await tools.saveAppAgentTool.execute({ path: projects }, context)).text).toContain('save_app refused the project: This folder is not an app project')
    writeAppProject(folder, { ...NOTES, migrations: { '0001_notes.sql': NOTES.migrations?.['0001_notes.sql'] ?? '', '0002_bad.sql': 'DROP TABLE missing;' } })
    expect((await tools.saveAppAgentTool.execute({ path: folder }, context)).text).toContain('Saved a new revision of "Notes"')
    const broken = await tools.deployAppAgentTool.execute({ app: 'notes' }, context)
    expect(broken.ok).toBe(false)
    expect(broken.text).toContain('Version 2 of "Notes" (app: notes) failed: The migration 0002_bad.sql failed')
    expect(broken.text).toContain('Version 1 still runs.')

    // checkout_app, list_apps, and inspect_app are how a later session finds, changes, and repairs the app.
    const listed = await tools.listAppsAgentTool.execute({}, context)
    expect(listed.text).toContain('- notes (id: ')
    expect(listed.text).toContain('    mutation add: Save one note.')
    expect(listed.text).toContain('    needs the user: Version 2 did not start')
    const checkedOut = await tools.checkoutAppAgentTool.execute({ app: 'notes', path: 'again' }, context)
    expect(checkedOut.text).toContain(`to ${join(projects, 'again')}`)
    expect(checkedOut.text).toContain('Save the change with save_app and this folder as path')
    const build = await tools.inspectAppAgentTool.execute({ app: 'notes', view: 'build' }, context)
    expect(build.text).toContain('Version 2: failed — The migration 0002_bad.sql failed')

    // A deleted app leaves no session linked to it when the host wires that part (boot-server.ts).
    const { unlinkAppFromSessions } = await import('@solus/server/data/sessions/session-links')
    apps.addLifecyclePart({ activated: async () => {}, removed: (removed) => unlinkAppFromSessions(removed.id) })
    await apps.delete(owner, app?.id ?? '')
    expect(await readOwnSessionArtifacts(ANY_ORGANIZATION, 'session-1')).toEqual([])
    uninstall()
  })

  test('inspect_app gives an agent what it needs to repair an app, and set_app_signal_action makes a signal do something', async () => {
    // WHY: agents repair apps. With one error message and no log, an agent
    // guesses; with the call's input, its lines, and its trace, it reads.
    const { apps, clock } = await host()
    // SAFETY: the tools read the working directory, the session id, and the provider of their context.
    const context = { cwd: projects, sessionId: () => null, provider: 'claude-code' } as never
    const { app } = await ship(apps, project(REPORTS))
    await call(apps, app.id, appOperationCallName('save'), { title: 'Q3', rows: 3 })
    await expect(call(apps, app.id, appOperationCallName('broken'))).rejects.toThrow()

    const overview = await tools.inspectAppAgentTool.execute({ app: 'reports' }, context)
    expect(overview.text).toContain('"Reports" (app: reports): version 1 runs. Agent access is on.')
    expect(overview.text).toContain('Last 24 hours: 2 calls, 1 failed')
    expect(overview.text).toContain('Instructions:\nCall list before you make a report.')
    expect(overview.text).toContain('Workflows: build, later')
    expect(overview.text).toContain('Signals: report.ready')

    const failed = await tools.inspectAppAgentTool.execute({ app: 'reports', view: 'calls', outcome: 'failed' }, context)
    const callId = /^- (\S+) /.exec(failed.text)?.[1] ?? ''
    expect(failed.text).toContain('broken (ui, v1): failed')
    const one = await tools.inspectAppAgentTool.execute({ app: 'reports', view: 'call', id: callId }, context)
    expect(one.text).toContain('input: {}')
    expect(one.text).toContain('Error: the report is broken')
    expect(one.text).toContain('[error] about to fail')

    expect(tools.setAppSignalActionAgentTool.requiresApproval).toBe(true)
    // The actions of a signal are in the order they were made.
    clock.now += 1
    const set = await tools.setAppSignalActionAgentTool.execute({ app: 'reports', signal: 'report.ready', type: 'send_to_session', session_id: 'session-9' }, context)
    expect(set.text).toBe('The signal report.ready now has 2 actions: notify (on), send_to_session (on).')
    // A type that needs a target and has none says what it needs.
    expect((await tools.setAppSignalActionAgentTool.execute({ app: 'reports', signal: 'report.ready', type: 'run_automation' }, context)).text).toBe('set_app_signal_action failed: send_to_session needs session_id, and run_automation needs automation_id.')
    expect((await tools.inspectAppAgentTool.execute({ app: 'reports', view: 'signals' }, context)).text).toContain('- report.ready: A report is ready.')
  })

  test('an outside app finds and runs app operations through tool_search and tool_call, within its grant', async () => {
    // WHY: Claude Desktop, ChatGPT, or Cursor read tools/list once, when they
    // start (plans/035 §7.3). App operations are behind tool_search and
    // tool_call, so a new app or a deploy reaches them with no restart. A
    // read grant only reads: it runs a query and never a mutation. An outside
    // app has no inspect_app, so the app's instructions are a tool it can call.
    const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client')
    const { appToolServer } = await import('@solus/server/execution/agents/tools/agent-tool-endpoint')
    const apps = await service()
    const notes = (await ship(apps, project(NOTES))).app
    await ship(apps, project(REPORTS))
    const connect = async (access: 'read' | 'write') => {
      const server = await appToolServer({ grantId: `grant-${access}`, access, actor: owner.actor, signal: new AbortController().signal })
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      const client = new Client({ name: 'outside-app', version: '1.0.0' })
      await client.connect(clientSide)
      return client
    }
    const textOf = (result: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>['callTool']>>) => (result.content as { text: string }[])[0]?.text ?? ''

    const reader = await connect('read')
    const listed = (await reader.listTools()).tools.map((tool) => tool.name)
    expect(listed).toEqual(expect.arrayContaining(['tool_search', 'tool_call', 'list_works']))
    expect(listed).not.toContain('notes__add')

    const found = JSON.parse(textOf(await reader.callTool({ name: 'tool_search', arguments: { query: '' } }))).tools as { name: string; description: string }[]
    expect(found.map((tool) => tool.name)).toEqual(expect.arrayContaining(['notes__list', 'notes__add', 'reports__list', 'reports__app-instructions']))
    expect(found.find((tool) => tool.name === 'reports__list')?.description).toContain('Read this app\'s instructions once with reports__app-instructions before you use it.')
    expect(textOf(await reader.callTool({ name: 'tool_call', arguments: { name: 'reports__app-instructions' } }))).toBe('Call list before you make a report.')

    const refused = await reader.callTool({ name: 'tool_call', arguments: { name: 'notes__add', arguments: { text: 'from a read grant' } } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toBe('notes__add changes the app\'s records, and this app was approved to read only. Connect it again with write access.')
    const read = await reader.callTool({ name: 'tool_call', arguments: { name: 'notes__list' } })
    expect(read.isError).toBeFalsy()
    expect(JSON.parse(textOf(read))).toEqual([])

    const writer = await connect('write')
    const writerTools = (await writer.listTools()).tools.map((tool) => tool.name)
    const added = await writer.callTool({ name: 'tool_call', arguments: { name: 'notes__add', arguments: { text: 'from Claude Desktop' } } })
    expect(added.isError).toBeFalsy()
    expect(await call(apps, notes.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'from Claude Desktop' }])
    // The call log shows an agent that is in no session.
    expect((await apps.calls(owner, notes.id)).find((entry) => entry.operation === 'add')).toMatchObject({ caller: { kind: 'agent', sessionId: null } })

    // An app with agent access off is not found, and the person's apps come back when it is on again.
    await apps.setAgentAccess(owner, notes.id, false)
    const again = await connect('write')
    // The tool list stays the same, so the app needs no restart when the person turns it on again.
    expect((await again.listTools()).tools.map((tool) => tool.name)).toEqual(writerTools)
    expect(textOf(await again.callTool({ name: 'tool_call', arguments: { name: 'notes__list' } }))).toBe('Unknown app operation: notes__list. Find it with tool_search.')
    await apps.setAgentAccess(owner, notes.id, true)
  })

  test('appOperationAgentTools enforces per-operation requiresApproval and defaults to false when omitted', async () => {
    // WHY: operations marked requiresApproval: true must require user approval before an agent runs them,
    // while operations that omit the flag keep working without approval for backwards compatibility.
    const apps = await service()
    const folder = project({
      app: `import { defineApp, query, mutation } from '@solus/app/backend'
export default defineApp({
  name: 'Vault',
  operations: {
    list: query({ description: 'List items.' }, () => []),
    reveal: query({ description: 'Reveal sensitive item.', requiresApproval: true }, () => 'top-secret'),
    purge: mutation({ description: 'Delete all items.', requiresApproval: true }, () => null),
    ping: mutation({ description: 'Ping.', requiresApproval: false }, () => 'pong'),
  },
})`,
    })
    await ship(apps, folder)
    const agentTools = await tools.appOperationAgentTools(owner.actor, new Set())
    const byName = new Map(agentTools.map((tool) => [tool.name, tool.requiresApproval]))
    expect(byName.get('vault__list')).toBe(false)
    expect(byName.get('vault__reveal')).toBe(true)
    expect(byName.get('vault__purge')).toBe(true)
    expect(byName.get('vault__ping')).toBe(false)
  })
})
