import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appConfigCallName, appOperationCallName, appStorageCallName } from '@solus/contracts/apps'
import { writeAppProject, type AppProjectFiles } from './helpers/app-project'
import { DatabaseSync } from './helpers/bun-sqlite'
import { NOTES, REPORTS, by, call, change, connectionCalls, dataDir, describeWithNode, eventually, events, host, installAppsHost, member, owner, project, projects, save, schedulesModule, service, ship, store, toolCalls, tools, webhooksModule } from './helpers/apps-host'

installAppsHost()

describeWithNode('an app on a host', () => {
  test('a save makes a revision and runs nothing; a deploy builds that revision on the host and makes it run', async () => {
    // WHY: this is the whole promise of an app, in its two acts (decision 6).
    // A save changes nothing that runs. The host builds what it runs
    // (decision 4), so a version's build is the build of its revision.
    const { apps, builder } = await host()
    const changed: string[] = []
    const stop = events.onAppDataChanged((event) => changed.push(event.appId))
    const folder = project(NOTES)
    const saved = await save(apps, folder)
    expect(saved).toMatchObject({ created: true, removed: [] })
    expect(saved.app).toMatchObject({ slug: 'notes', name: 'Notes', activeVersion: null, latestVersion: null, latestRevision: saved.revision, hasUndeployedRevision: true })
    expect(builder.revisionBuilds).toBe(0)
    await expect(call(apps, 'notes', appOperationCallName('list'))).rejects.toThrow('This app has no version that runs.')

    const deployed = await apps.deploy(owner, { app: 'notes', createdBy: by })
    expect(deployed).toMatchObject({ version: 1, active: true, error: null, secretsMissing: ['token'] })
    expect(deployed.app).toMatchObject({ activeVersion: 1, hasUi: true, operationCount: 5, hasUndeployedRevision: false, agentAccess: true })
    expect(builder.revisionBuilds).toBe(1)
    // The project folder has no build: the host built the revision in a folder of its own.
    expect(existsSync(join(folder, 'dist'))).toBe(false)
    const id = deployed.app.id

    expect(await call(apps, id, appOperationCallName('add'), { text: 'first' })).toEqual({ id: 1, text: 'first' })
    expect(await call(apps, 'notes', appOperationCallName('list'))).toEqual([{ id: 1, text: 'first' }])
    // Only the mutation changed the data, so only it tells open UIs to read again.
    expect(changed).toEqual([id])
    stop()

    expect(existsSync(join(dataDir, 'apps', 'data', id, 'app.sqlite'))).toBe(true)
    expect((await apps.ui(owner, id))?.html).toContain('<title>Notes</title>')
    expect((await apps.versions(owner, id))[0]).toMatchObject({ number: 1, state: 'active', revision: saved.revision, protocol: 4, message: 'A change' })
    expect(await apps.revisions(owner, id)).toEqual([expect.objectContaining({ commit: saved.revision, message: 'A change', versions: [1] })])
  })

  test('two sessions cannot lose each other\'s change: a save from an older revision is refused', async () => {
    // WHY (decision 7): Solus runs many sessions. Two of them checked out
    // version 3, and the second deploy removed the first one's change with no
    // message. A save now names the revision it started from.
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    const first = join(projects, 'session-one')
    const second = join(projects, 'session-two')
    await apps.checkout(owner, 'notes', first)
    await apps.checkout(owner, 'notes', second)

    writeAppProject(first, { ...NOTES, source: { 'src/App.tsx': 'export default function App() { return "one" }\n' } })
    const one = await save(apps, first)
    writeAppProject(second, { ...NOTES, source: { 'src/App.tsx': 'export default function App() { return "two" }\n' } })
    await expect(save(apps, second)).rejects.toThrow(`The app notes has a newer revision (${one.revision.slice(0, 7)}) than the one this project came from`)
    expect((await apps.read(owner, app.id)).app.latestRevision).toBe(one.revision)

    // The second session takes the newer source and saves on top of it.
    const again = join(projects, 'session-two-again')
    await apps.checkout(owner, 'notes', again)
    expect(readFileSync(join(again, 'src/App.tsx'), 'utf8')).toContain('"one"')
    writeAppProject(again, { ...NOTES, source: { 'src/App.tsx': 'export default function App() { return "one and two" }\n' } })
    expect((await save(apps, again)).created).toBe(false)
    expect((await apps.revisions(owner, app.id)).map((revision) => revision.versions)).toEqual([[], [], [1]])
  })

  test('a folder that was not checked out from an app cannot replace its source, and a save says which files it removed', async () => {
    const apps = await service()
    const folder = project({ ...NOTES, source: { 'src/App.tsx': 'x\n', 'src/extra.ts': 'export const extra = 1\n' } })
    await ship(apps, folder)
    await expect(save(apps, project(NOTES), 'notes')).rejects.toThrow('This folder was not checked out from notes')
    await expect(save(apps, project(NOTES), 'missing')).rejects.toThrow('This host has no app named missing.')
    // The folder of the first save names its app, so a later save needs no `app`.
    writeAppProject(folder, NOTES)
    expect((await save(apps, folder)).removed).toEqual(['src/extra.ts'])
    await expect(save(apps, projects)).rejects.toThrow('This folder is not an app project')
  })

  test('a build that fails is a failed version with its build log, and the version before it still runs', async () => {
    // WHY: a bad deploy must not take a working app down, and the agent that
    // made it needs the build's own words to repair it.
    const apps = await service()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    await call(apps, app.id, appOperationCallName('add'), { text: 'still here' })
    const broken = await change(apps, folder, { ...NOTES, app: 'export default defineApp({' })
    expect(broken).toMatchObject({ version: 2, active: false })
    expect(broken.error).toContain('The build failed')
    expect(broken.buildLog).toBeTruthy()
    expect(broken.app).toMatchObject({ activeVersion: 1, latestVersion: 2, hasUndeployedRevision: false })
    expect(broken.app.attention.map((item) => item.kind)).toContain('version-failed')
    expect((await apps.buildLog(owner, app.id, 2)).log).toBe(broken.buildLog ?? '')
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'still here' }])
    await expect(apps.activate(owner, app.id, 2)).rejects.toThrow('Version 2 has no build')
  })

  test('a query gets a read-only database, whatever its code does', async () => {
    // WHY: an agent's session treats a query as a read. The descriptor says
    // which operations are queries, and the host holds them to it.
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    await expect(call(apps, app.id, appOperationCallName('sneak'))).rejects.toThrow(/readonly|read-only/i)
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([])
    expect((await apps.calls(owner, app.id))[1]).toMatchObject({ operation: 'sneak', outcome: 'failed' })
  })

  test('an operation refuses input its schema does not accept, and a result its output schema does not accept', async () => {
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    await expect(call(apps, app.id, appOperationCallName('add'), { text: 7 })).rejects.toThrow('Invalid input for add')
    await expect(call(apps, app.id, appOperationCallName('missing'))).rejects.toThrow('This app has no operation named missing.')
    const reports = await ship(apps, project(REPORTS))
    await expect(call(apps, reports.app.id, appOperationCallName('wrongShape'))).rejects.toThrow('returned a value that its output schema does not accept')
  })

  test('a new version keeps the data and applies only its new migrations', async () => {
    // WHY: a deploy changes code, never data. A migration that ran once must
    // not run again, or the second deploy of any app would fail.
    const apps = await service()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    await call(apps, app.id, appOperationCallName('add'), { text: 'kept' })
    const next = await change(apps, folder, {
      ...NOTES,
      app: NOTES.app.replace("'SELECT id, text FROM notes ORDER BY id'", "'SELECT id, text, done FROM notes ORDER BY id'"),
      migrations: { ...NOTES.migrations, '0002_done.sql': 'ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' },
    })
    expect(next).toMatchObject({ version: 2, active: true, created: false })
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'kept', done: 0 }])
    expect((await apps.versions(owner, app.id)).map((version) => [version.number, version.state])).toEqual([[2, 'active'], [1, 'superseded']])
    const diff = await apps.versionDiff(owner, app.id, 2)
    expect(diff).toMatchObject({ version: 2, base: 1, truncated: false })
    expect(diff.patch).toContain('+ALTER TABLE notes ADD COLUMN done')
    expect((await apps.revisionDiff(owner, app.id, next.revision)).patch).toContain('+ALTER TABLE notes ADD COLUMN done')
  })

  test('a version whose migration fails is recorded as failed, and the version before it still runs on a schema that did not change', async () => {
    const apps = await service()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    await call(apps, app.id, appOperationCallName('add'), { text: 'still here' })
    const broken = await change(apps, folder, { ...NOTES, migrations: { ...NOTES.migrations, '0002_ok.sql': 'ALTER TABLE notes ADD COLUMN done INTEGER;', '0003_bad.sql': 'ALTER TABLE missing ADD COLUMN x;' } })
    expect(broken).toMatchObject({ version: 2, active: false })
    expect(broken.error).toContain('The migration 0003_bad.sql failed')
    expect(broken.app).toMatchObject({ activeVersion: 1, latestVersion: 2 })
    // The migration before the bad one was not applied: the old version reads the schema it was written for.
    const db = new DatabaseSync(join(dataDir, 'apps', 'data', app.id, 'app.sqlite'))
    expect(db.prepare('PRAGMA table_info(notes)').all().map((column) => (column as { name: string }).name)).toEqual(['id', 'text'])
    db.close()
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'still here' }])
  })

  test('an earlier version can be made active again; the data is not rewound', async () => {
    const apps = await service()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    await change(apps, folder, { ...NOTES, app: NOTES.app.replace("name: 'Notes'", "name: 'Notes two'") })
    await call(apps, app.id, appOperationCallName('add'), { text: 'written by version 2' })
    const state = await apps.activate(owner, app.id, 1)
    expect(state.app).toMatchObject({ activeVersion: 1, name: 'Notes', slug: 'notes' })
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'written by version 2' }])
    // WHY: a rollback is history. The version keeps each time it became active and the version it replaced,
    // so the Versions section says "Rolled back to v1 from v2" and not only which one runs now.
    const [second, first] = await apps.versions(owner, app.id)
    expect(second?.activations.map((entry) => entry.previous)).toEqual([1])
    expect(first?.activations.map((entry) => entry.previous)).toEqual([null, 2])
    expect(first!.activations[1]!.at).toBeGreaterThanOrEqual(second!.activations[0]!.at)
    // The rollback's change is the two revisions it moved between.
    const [newer, older] = await apps.revisions(owner, app.id)
    expect(newer?.stats).toMatchObject({ files: 1, additions: 1, deletions: 1 })
    const rollback = await apps.revisionDiff(owner, app.id, older!.commit, newer!.commit)
    expect(rollback.base).toBe(newer!.commit)
    expect(rollback.patch).toContain("-  name: 'Notes two'")
  })

  test('the owner renames, describes, and colours an app, and a deploy does not undo it', async () => {
    // WHY: the manifest names the app on each deploy. A name the owner gave must not
    // change back when an agent ships a new version.
    const apps = await service()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    const renamed = await apps.update(owner, app.id, { name: '  Team notes ', description: 'Notes for the team.', colorHue: 210 })
    expect(renamed.app).toMatchObject({ name: 'Team notes', description: 'Notes for the team.', manifestName: 'Notes', colorHue: 210, slug: 'notes' })

    const shipped = await change(apps, folder, { ...NOTES, app: NOTES.app.replace("name: 'Notes'", "name: 'Notes two'") })
    expect(shipped.app).toMatchObject({ name: 'Team notes', description: 'Notes for the team.', manifestName: 'Notes two', colorHue: 210 })

    // A field left out stays; null goes back to the manifest and to the colour from the id.
    expect((await apps.update(owner, app.id, { colorHue: null })).app).toMatchObject({ name: 'Team notes', colorHue: null })
    expect((await apps.update(owner, app.id, { name: null, description: '' })).app).toMatchObject({ name: 'Notes two', description: 'Keeps notes.' })
    // Typing the manifest's own name keeps no copy of it, so the next rename in the manifest shows.
    await apps.update(owner, app.id, { name: 'Notes two' })
    expect((await change(apps, folder, NOTES)).app.name).toBe('Notes')
    await expect(apps.update(member, app.id, { name: 'Mine' })).rejects.toThrow('Only the owner of this host can use its apps.')
  })

  test('a stopped app runs no operation until it is started', async () => {
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    expect((await apps.stop(owner, app.id)).app.attention.map((item) => item.kind)).toContain('stopped')
    await expect(call(apps, app.id, appOperationCallName('list'))).rejects.toThrow('This app is stopped.')
    expect(await apps.running(owner)).toEqual([])
    const started = await apps.start(owner, app.id)
    expect(started.runtime).toMatchObject({ inFlight: 0 })
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([])
    expect((await apps.read(owner, app.id)).runtime.running).toBe(true)
  })

  test('a secret reaches the backend and never a client', async () => {
    // WHY: a database URL or a key must not be in the app's data, where the UI reads it.
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    expect((await call(apps, app.id, appOperationCallName('whoAndWhat'))).token).toBeNull()
    const state = await apps.secretSet(owner, app.id, 'token', 's3cret')
    expect(state.secrets).toEqual([{ name: 'token', label: 'API token', description: '', isSet: true }])
    expect(JSON.stringify(state)).not.toContain('s3cret')
    expect(await call(apps, app.id, appOperationCallName('whoAndWhat'))).toEqual({ caller: { kind: 'ui', role: 'owner' }, token: 's3cret' })
    await expect(apps.secretSet(owner, app.id, 'other', 'x')).rejects.toThrow('This app declares no secret named other.')
    await apps.secretSet(owner, app.id, 'token', null)
    expect((await call(apps, app.id, appOperationCallName('whoAndWhat'))).token).toBeNull()
  })

  test('the owner changes a config value; the backend and the UI read it, and a value a new version does not take falls back to the default', async () => {
    // WHY: config is how a person changes what an app does without a new
    // version. A value the field does not take must never reach the app, and a
    // change must reach a runner that already started with the old value.
    const digest = (max: number): AppProjectFiles => ({
      app: `import { defineApp, query } from '@solus/app/backend'
export default defineApp({
  name: 'Digest',
  config: {
    hour: { type: 'number', label: 'Hour', default: 3, min: 0, max: ${max}, integer: true },
    team: { type: 'choice', label: 'Team', default: 'eng', options: [{ value: 'eng', label: 'Engineering' }, { value: 'ops', label: 'Operations' }] },
  },
  operations: { settings: query({}, (ctx) => ctx.config) },
})`,
    })
    const apps = await service()
    const folder = project(digest(23))
    const { app } = await ship(apps, folder)
    expect(await call(apps, app.id, appOperationCallName('settings'))).toEqual({ hour: 3, team: 'eng' })
    expect(await call(apps, app.id, appConfigCallName('get'))).toEqual({ hour: 3, team: 'eng' })

    const changed: string[] = []
    const stop = events.onAppDataChanged((event) => changed.push(event.appId))
    const state = await apps.configSet(owner, app.id, 'hour', 7)
    stop()
    expect(state.config.map(({ name, value, isDefault }) => ({ name, value, isDefault }))).toEqual([{ name: 'hour', value: 7, isDefault: false }, { name: 'team', value: 'eng', isDefault: true }])
    // An open UI reads the config and its queries again.
    expect(changed).toEqual([app.id])
    // The runner that answered before started with hour 3; the next call has the new value.
    expect(await call(apps, app.id, appOperationCallName('settings'))).toEqual({ hour: 7, team: 'eng' })

    await expect(apps.configSet(owner, app.id, 'hour', 30)).rejects.toThrow('Hour is at most 23.')
    await expect(apps.configSet(owner, app.id, 'team', 'sales')).rejects.toThrow('Team takes one of Engineering, Operations.')
    await expect(apps.configSet(owner, app.id, 'other', 1)).rejects.toThrow('This app has no config field named other.')

    // A new version allows at most 5: the owner's 7 is not used, and the default is.
    await change(apps, folder, digest(5))
    expect(await call(apps, app.id, appOperationCallName('settings'))).toEqual({ hour: 3, team: 'eng' })
    await apps.configSet(owner, app.id, 'hour', 4)
    expect((await apps.configSet(owner, app.id, 'hour', null)).config[0]).toMatchObject({ value: 3, isDefault: true })
  })

  test('the backend calls an integration the app names, with the caller\'s own integration', async () => {
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    expect(await call(apps, app.id, appOperationCallName('issues'))).toEqual({ issues: ['ENG-1'] })
    expect(toolCalls).toEqual([{ integrationId: 'int-linear', tool: 'list_issues', input: { team: 'ENG' } }])
    // The UI reaches the same integration by its call name, and no integration the app does not name.
    expect(await call(apps, app.id, 'linear/list_issues', { team: 'OPS' })).toEqual({ issues: ['ENG-1'] })
    await expect(call(apps, app.id, 'jira/list_issues')).rejects.toThrow('This app does not name the integration jira.')
  })

  test('a built-in connection the app names is a role, with one request tool', async () => {
    // WHY: an app reaches the person's GitHub, Atlassian, and Google connections without a token of its own.
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    expect(await call(apps, app.id, 'github/request', { path: '/repos/acme/web/pulls' })).toEqual([{ number: 7 }])
    expect(connectionCalls).toEqual([{ provider: 'github', input: { path: '/repos/acme/web/pulls' } }])
    await expect(call(apps, app.id, 'github/list_pulls')).rejects.toThrow('GitHub has one tool for an app: request.')
    expect((await apps.read(owner, app.id)).roles).toEqual([
      { slug: 'linear', scope: 'user', name: 'Linear', connected: true },
      { slug: 'github', scope: 'user', name: 'GitHub', connected: true },
      { slug: 'atlassian', scope: 'user', name: 'Atlassian', connected: false },
    ])
    // The person's own MCP integration with that slug comes first.
    expect(await call(apps, app.id, 'linear/list_issues', { team: 'OPS' })).toEqual({ issues: ['ENG-1'] })
  })

  test('storage is the app\'s own, with no backend call', async () => {
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    await call(apps, app.id, appStorageCallName('set'), { key: 'view', value: { sort: 'new' } })
    expect(await call(apps, app.id, appStorageCallName('get'), { key: 'view' })).toEqual({ sort: 'new' })
    expect(await call(apps, app.id, appStorageCallName('keys'))).toEqual(['view'])
  })

  test('only the owner of the host uses an app', async () => {
    // WHY: an app is code on the host with the owner's files in reach (decision 12).
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    expect(await apps.list(member)).toEqual([])
    await expect(apps.read(member, app.id)).rejects.toThrow('Only the owner of this host can use its apps.')
    await expect(apps.call(member, app.id, appOperationCallName('list'), '{}')).rejects.toThrow('Only the owner of this host can use its apps.')
    await expect(apps.save(member, { project: project(NOTES), createdBy: by })).rejects.toThrow('Only the owner of this host can use its apps.')
    await expect(apps.deploy(member, { app: app.id, createdBy: by })).rejects.toThrow('Only the owner of this host can use its apps.')
  })

  test('a second app with the same name, and a name an integration has, get another slug', async () => {
    // WHY: an app's slug and an integration's slug are both `tools.<slug>` to an agent.
    const apps = await service()
    expect((await save(apps, project(NOTES))).app.slug).toBe('notes')
    expect((await save(apps, project(NOTES))).app.slug).toBe('notes-2')
    expect((await save(apps, project({ ...NOTES, app: NOTES.app.replace("name: 'Notes'", "name: 'Linear'") }))).app.slug).toBe('linear-2')
    expect((await save(apps, project({ ...NOTES, app: NOTES.app.replace("name: 'Notes'", "name: 'GitHub'") }))).app.slug).toBe('github-2')
  })

  test('the source of a revision comes back out of the repository as files, with where it came from', async () => {
    // WHY: a later session changes an app from its source; the host is the only place that keeps it.
    const apps = await service()
    const shipped = await ship(apps, project(NOTES))
    const folder = join(projects, 'checkout')
    const written = await apps.checkout(owner, 'notes', folder)
    expect(written).toMatchObject({ revision: shipped.revision, files: 5 })
    expect(readFileSync(join(folder, 'app.ts'), 'utf8')).toBe(NOTES.app)
    expect(readFileSync(join(folder, 'migrations/0001_notes.sql'), 'utf8')).toBe(NOTES.migrations?.['0001_notes.sql'])
    expect(JSON.parse(readFileSync(join(folder, '.solus/app.json'), 'utf8'))).toEqual({ app: 'notes', revision: shipped.revision })
    // The build is in the repository too, on its own ref, and not in the source.
    expect(existsSync(join(folder, 'dist'))).toBe(false)
    const repository = (await apps.read(owner, shipped.app.id)).repositoryPath
    const refs = spawnSync('git', ['--git-dir', repository, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim().split('\n')
    expect(refs).toEqual(['refs/heads/main', 'refs/solus/versions/1'])
    // The origin file is the folder's own, never a part of a revision.
    expect(spawnSync('git', ['--git-dir', repository, 'ls-tree', '-r', '--name-only', 'refs/heads/main'], { encoding: 'utf8' }).stdout).not.toContain('.solus')
  })

  test('a deleted app leaves nothing on the host', async () => {
    const { apps, builder } = await host()
    const { app } = await ship(apps, project(REPORTS))
    await call(apps, app.id, appOperationCallName('save'), { title: 'gone soon', rows: 1 })
    const repository = (await apps.read(owner, app.id)).repositoryPath
    expect(await apps.delete(owner, app.id)).toBe(true)
    expect(existsSync(repository)).toBe(false)
    expect(existsSync(join(dataDir, 'apps', 'data', app.id))).toBe(false)
    expect(await apps.list(owner)).toEqual([])
    expect(await store.listCalls(app.id, 10)).toEqual([])
    await expect(apps.read(owner, app.id)).rejects.toThrow('This app is not available.')
    void builder
  })

  test('a schedule runs its mutation with no caller there, from the deploy that declares it', async () => {
    // WHY: an app works when nobody looks at it. A schedule is on from the
    // deploy (decision 16), runs as the app's owner, and records how it ended.
    const apps = await service()
    let now = Date.parse('2026-11-12T10:00:00Z')
    const schedules = new schedulesModule.AppSchedules(apps, () => now)
    apps.addLifecyclePart(schedules)
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    expect(await schedules.list(owner, app.id)).toEqual([expect.objectContaining({ name: 'tick', run: 'add', enabled: true, nextRunAt: now + 5 * 60_000, lastOutcome: null })])

    await schedules.tick()
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([])
    now += 5 * 60_000
    await schedules.tick()
    await eventually(async () => ((await schedules.list(owner, app.id))[0]?.lastOutcome ?? null), 'the schedule ran')
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'tick' }])
    expect((await schedules.list(owner, app.id))[0]).toMatchObject({ lastOutcome: 'ok', lastRunAt: now, nextRunAt: now + 5 * 60_000 })
    expect((await apps.calls(owner, app.id, 10, { callerKind: 'schedule' }))[0]).toMatchObject({ operation: 'add', caller: { kind: 'schedule', name: 'tick' } })

    // A paused schedule is not due; a version that no longer declares it removes it.
    expect((await schedules.set(owner, app.id, 'tick', false))[0]).toMatchObject({ enabled: false, nextRunAt: null })
    now += 60 * 60_000
    await schedules.tick()
    expect(await call(apps, app.id, appOperationCallName('list'))).toHaveLength(1)
    await change(apps, folder, { ...NOTES, app: NOTES.app.replace("schedules: { tick: { every: { minutes: 5 }, run: 'add', input: { text: 'tick' } } },", '') })
    expect(await schedules.list(owner, app.id)).toEqual([])
    schedules.stop()
  })

  test('each webhook an app declares is a webhook record that calls its mutation', async () => {
    // WHY: the webhook owner holds the URL, the check, and the log; the app only says which mutation runs.
    const apps = await service()
    const records = new Map<string, { name: string; actions: object[] }>()
    const webhooks = new webhooksModule.AppWebhooks(apps, {
      create: async (input) => {
        const id = `hook-${records.size + 1}`
        records.set(id, { name: input.name, actions: input.actions })
        // SAFETY: the part reads only the id of what it made.
        return { id } as never
      },
      update: async (id, patch) => {
        const record = records.get(id)
        if (!record) return null
        records.set(id, { name: patch.name ?? record.name, actions: patch.actions ?? record.actions })
        // SAFETY: the part reads only whether the update found the record.
        return { id } as never
      },
      delete: async (id) => records.delete(id),
      readWithUrl: async () => null,
    })
    apps.addLifecyclePart(webhooks)
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    expect([...records.values()]).toEqual([{ name: 'Notes: pushed', actions: [{ id: 'app', type: 'call_app', enabled: true, filters: [], template: '', appId: app.id, operation: 'add' }] }])

    // A webhook's request is the mutation's input, and the call names the webhook.
    await apps.callOperation(app.id, 'add', { text: 'from a webhook' }, { kind: 'webhook', webhookId: 'hook-1' }, null)
    expect((await apps.calls(owner, app.id))[0]).toMatchObject({ caller: { kind: 'webhook', webhookId: 'hook-1' }, outcome: 'ok' })

    await apps.deploy(owner, { app: app.id, createdBy: by })
    expect(records.size).toBe(1)
    await change(apps, folder, { ...NOTES, app: NOTES.app.replace("webhooks: { pushed: { verify: { scheme: 'token', source: { kind: 'header', name: 'x-token' } }, run: 'add' } },", '') })
    expect(records.size).toBe(0)
  })

  test('each operation of a running app is a tool for an agent, while the app\'s agent access is on', async () => {
    // WHY: an app the user asked for is something their agents can use, not
    // only a screen. Its owner decides that: every operation of every app in
    // every run is too much when the host has many apps.
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    const agentTools = await tools.appOperationAgentTools(owner.actor, new Set(['notes__sneak']))
    expect(agentTools.map((tool) => tool.name)).toEqual(['notes__list', 'notes__add', 'notes__whoAndWhat', 'notes__issues'])
    const add = agentTools.find((tool) => tool.name === 'notes__add')
    expect(add?.description).toBe('Notes: Save one note.')
    expect(Object.keys(add?.inputFields ?? {})).toEqual(['text'])
    // SAFETY: the tool reads only the session id of its context.
    const result = await add?.execute({ text: 'by an agent' }, { sessionId: () => 'session-1' } as never)
    expect(result).toEqual({ ok: true, text: JSON.stringify({ id: 1, text: 'by an agent' }, null, 1) })
    expect((await apps.calls(owner, app.id))[0]).toMatchObject({ caller: { kind: 'agent', sessionId: 'session-1' } })
    expect(await tools.appOperationAgentTools(member.actor, new Set())).toEqual([])

    expect((await apps.setAgentAccess(owner, app.id, false)).app.agentAccess).toBe(false)
    expect(await tools.appOperationAgentTools(owner.actor, new Set())).toEqual([])
    // The app still runs for its own UI.
    expect(await call(apps, app.id, appOperationCallName('list'))).toHaveLength(1)
    await apps.setAgentAccess(owner, app.id, true)

    // An operation with an output schema says its shape, and an app with instructions says where they are.
    await ship(apps, project(REPORTS))
    const list = (await tools.appOperationAgentTools(owner.actor, new Set())).find((tool) => tool.name === 'reports__list')
    expect(list?.description).toContain('Reports: Every report.\nReturns: {')
    expect(list?.description).toContain('"rows"')
    expect(list?.description).toContain('Read this app\'s instructions once with inspect_app before you use it.')
  })
})
