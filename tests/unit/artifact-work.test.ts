import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { NormalizedEvent } from '@solus/contracts/types'
import { artifactPreview, resolveArtifactTitle, workPreview } from '@solus/contracts/work-preview'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskModule = typeof import('@solus/server/data/tasks/task')
type WorksModule = typeof import('@solus/server/data/works/works')
type ArtifactToolsModule = typeof import('@solus/server/execution/agents/tools/artifact-tools')
type WorkToolsModule = typeof import('@solus/server/execution/agents/tools/work-tools')
type TaskArtifactsModule = typeof import('@solus/server/data/tasks/task-artifacts')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let works: WorksModule
let artifactTools: ArtifactToolsModule
let workTools: WorkToolsModule
let taskArtifacts: TaskArtifactsModule
const previousDataDir = process.env.SOLUS_DATA_DIR

const HTML = '<!doctype html><html><head><title>Latency &amp; throughput</title></head><body><h1>Chart</h1></body></html>'
const SESSION_ID = '5f0d1f2e-9b3a-4c1d-8e7f-2a1b3c4d5e6f'

beforeEach(async () => { await installTestWorkspaceTools() })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-artifact-work-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  works = await import('@solus/server/data/works/works')
  artifactTools = await import('@solus/server/execution/agents/tools/artifact-tools')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  taskArtifacts = await import('@solus/server/data/tasks/task-artifacts')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('an artifact is named the same way everywhere', () => {
  test('the caller\'s title wins, then the document title, then a fixed label', () => {
    // WHY: the host saves the work under this name and the renderer names a
    // replayed render with it; if the two rules differed, a reload could not
    // find the work its frame belongs to.
    expect(resolveArtifactTitle('Latency report', HTML)).toBe('Latency report')
    expect(resolveArtifactTitle('  ', HTML)).toBe('Latency & throughput')
    expect(resolveArtifactTitle(undefined, '<html><body>no title</body></html>')).toBe('Untitled artifact')
  })

  test('an artifact previews as its title, never as raw markup', () => {
    // WHY: the gallery shows the preview under the title. Two hundred bytes of
    // `<!doctype html><html…` says nothing about what the artifact shows.
    expect(workPreview('artifact', HTML)).toBe('Interactive artifact — Latency & throughput')
    expect(artifactPreview('<html></html>')).toBe('Interactive artifact')
    expect(workPreview('artifact', HTML)).not.toContain('<')
  })
})

describe('render_artifact persists a work', () => {
  test('create_work automatically links a session-authored work to its task', async () => {
    // WHY: the Link control is the manual way in and out. It must not replace
    // the default filing rule for a work created inside a task-owned session.
    const record = await taskStore.createTask('local', { title: 'Draft release notes' })
    const task = await tasks.Task.byId('local', record.id)
    await task.linkSession(SESSION_ID)

    const created: Array<{ workId: string }> = []
    await workTools.executeWorkTool(
      'create_work',
      { title: 'Release notes', doc_type: 'doc', content: '# Release notes' },
      {
        ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' },
        onWorkCreated: (work) => created.push(work),
      },
    )

    expect(created).toHaveLength(1)
    expect((await task.details()).links).toContainEqual(
      expect.objectContaining({ kind: 'work', targetKey: created[0].workId }),
    )
  })

  test('the render lands in the folio store as an artifact and the event names it', async () => {
    // WHY: this is what makes an artifact a first-class work — a durable id
    // the gallery lists, read_work answers, update_work revises, and a task
    // can link. The event carries the id so the conversation frame can open
    // the work without a second read.
    const emitted: Array<{ html: string; workId: string; title: string }> = []
    const result = await artifactTools.executeArtifactTool(
      { html: HTML },
      {
        ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' },
        onArtifact: (artifact) => emitted.push(artifact),
      },
    )

    expect(result.ok).toBe(true)
    expect(emitted).toHaveLength(1)
    const [artifact] = emitted
    expect(artifact.title).toBe('Latency & throughput')
    expect(result.text).toContain(artifact.workId)

    const stored = await works.loadWork('local', artifact.workId)
    expect(stored).toMatchObject({
      type: 'artifact',
      title: 'Latency & throughput',
      content: HTML,
      sessionIds: [SESSION_ID],
    })
    expect((await works.listWorks('local')).map((work) => work.id)).toContain(artifact.workId)
  })

  test('an artifact is not filed on the task unless asked', async () => {
    // WHY: a document written for a task belongs on it, but a render is
    // often a glance — a chart the user wanted to see once. Filing every one
    // on the ticket turned the task's Linked list into a gallery of throwaway
    // renders. The reader links or pins from the rail; the agent passes
    // link_to_task when the user asked for it on the task.
    const record = await taskStore.createTask('local', { title: 'Report latency' })
    const task = await tasks.Task.byId('local', record.id)
    await task.linkSession(SESSION_ID)

    const emitted: Array<{ workId: string }> = []
    const unlinked = await artifactTools.executeArtifactTool(
      { html: HTML, title: 'Latency report' },
      {
        ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' },
        onArtifact: (artifact) => emitted.push(artifact),
      },
    )
    expect(unlinked.text).toContain('not linked to a task')
    expect((await task.details()).links.map((link) => link.targetKey)).not.toContain(emitted[0].workId)

    const linked = await artifactTools.executeArtifactTool(
      { html: HTML, title: 'Latency report, kept', link_to_task: true },
      {
        ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' },
        onArtifact: (artifact) => emitted.push(artifact),
      },
    )
    expect(linked.text).toContain('linked to the session')
    expect((await task.details()).links).toContainEqual(
      expect.objectContaining({ kind: 'work', targetKey: emitted[1].workId, liveStatus: 'artifact' }),
    )
  })

  test('empty html is refused before anything is written', async () => {
    const result = await artifactTools.executeArtifactTool({ html: '   ' })
    expect(result.ok).toBe(false)
    expect(await works.listWorks('local')).toHaveLength(0)
  })

  test('the agent tool emits artifact_created with the work behind it', async () => {
    const events: NormalizedEvent[] = []
    const result = await artifactTools.renderArtifactAgentTool.execute(
      { html: HTML, title: 'Latency report' },
      {
        sessionId: () => SESSION_ID,
        solusSessionId: () => undefined,
        provider: 'claude-code',
        parentToolUseId: () => 'artifact-call-1',
        abortSignal: new AbortController().signal,
        cwd: '~',
        emit: (event: NormalizedEvent) => events.push(event),
      } as unknown as Parameters<typeof artifactTools.renderArtifactAgentTool.execute>[1],
    )
    expect(result.ok).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'artifact_created', toolId: 'artifact-call-1', kind: 'html', html: HTML, title: 'Latency report' })
    expect(events[0].type === 'artifact_created' && events[0].workId).toBeTruthy()
  })
})

describe('an artifact read from a compiled file', () => {
  // WHY: a compiled bundle is hundreds of kilobytes. When the agent had to
  // write it back as tool input, the copy was slow, costly, and could change
  // bytes, so agents opened the bundle in a browser and saved no work. The
  // host reads the file the agent wrote; the saved work is that file, exactly.
  const ctx = () => ({ sessionId: SESSION_ID, agentProvider: 'claude-code' as const, cwd: dataDir })

  function writeBundle(html: string, name = 'bundle.html'): string {
    mkdirSync(join(dataDir, 'chart'), { recursive: true })
    writeFileSync(join(dataDir, 'chart', name), html)
    return join('chart', name)
  }

  test('render_artifact saves the file a relative html_path names, resolved from the working directory', async () => {
    const emitted: Array<{ html: string; workId: string }> = []
    const result = await artifactTools.executeArtifactTool(
      { html_path: writeBundle(HTML) },
      { ctx: ctx(), onArtifact: (artifact) => emitted.push(artifact) },
    )
    expect(result.ok).toBe(true)
    expect(emitted[0].html).toBe(HTML)
    expect((await works.loadWork('local', emitted[0].workId))?.content).toBe(HTML)
  })

  test('update_work replaces an artifact with the file html_path names', async () => {
    const emitted: Array<{ workId: string }> = []
    await artifactTools.executeArtifactTool({ html: HTML }, { ctx: ctx(), onArtifact: (artifact) => emitted.push(artifact) })
    const revised = HTML.replace('<h1>Chart</h1>', '<h1>Revised</h1>')
    const result = await workTools.executeWorkTool('update_work', {
      work_id: emitted[0].workId, html_path: writeBundle(revised), expected_content_version: 1,
    }, { ctx: ctx() })
    expect(result).toEqual({ ok: true, text: expect.stringContaining('New content_version: 2.') })
    expect((await works.loadWork('local', emitted[0].workId))?.content).toBe(revised)
  })

  test('html_path is refused for a work that is not an artifact', async () => {
    // A document is markdown the agent writes; a compiled HTML file is never its body.
    await workTools.executeWorkTool('create_work', { title: 'Notes', doc_type: 'doc', content: '# Notes' }, { ctx: ctx() })
    const [doc] = await works.listWorks('local')
    const result = await workTools.executeWorkTool('update_work', {
      work_id: doc.id, html_path: writeBundle(HTML), expected_content_version: 1,
    }, { ctx: ctx() })
    expect(result.ok).toBe(false)
    expect((await works.loadWork('local', doc.id))?.content).toBe('# Notes')
  })

  test('an ambiguous, missing, empty, or non-HTML file is refused before anything is written', async () => {
    const refusals = [
      { html: HTML, html_path: writeBundle(HTML) },
      { html_path: 'chart/missing.html' },
      { html_path: writeBundle('  ', 'empty.html') },
      { html_path: writeBundle(HTML, 'bundle.txt') },
    ]
    for (const args of refusals) {
      expect((await artifactTools.executeArtifactTool(args, { ctx: ctx() })).ok).toBe(false)
    }
    expect(await works.listWorks('local')).toHaveLength(0)
  })
})

describe('an artifact Share moved to an organization', () => {
  test('read_work and update_work say which organization has it, not that it is missing', async () => {
    // WHY: the agent that made an artifact asks its own host for it. After
    // Share that host keeps only the location; "no work found" would send the
    // agent to make a second copy instead of telling the person where it is.
    const emitted: Array<{ workId: string }> = []
    await artifactTools.executeArtifactTool({ html: HTML }, { ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' }, onArtifact: (artifact) => emitted.push(artifact) })
    const workId = emitted[0].workId
    await works.removePushedWork('local', workId, (await works.exportWorkForCloud('local', workId)).fingerprint, 'org-1')

    const read = await workTools.executeWorkTool('read_work', { work_id: workId }, { ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' } })
    expect(read).toEqual({ ok: false, text: expect.stringContaining('moved to organization org-1') })
    const update = await workTools.executeWorkTool('update_work', { work_id: workId, content: HTML, expected_content_version: 1 }, { ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' } })
    expect(update).toEqual({ ok: false, text: expect.stringContaining('moved to organization org-1') })
  })
})

describe('an artifact on a ticket', () => {
  test('the still always goes; the source goes only where the ticket can hold it', () => {
    // WHY: GitHub's upload endpoint takes images and video only, so a comment
    // that named the .html would be held back — and the still with it. Jira
    // attaches any file, and a local task renders both itself.
    const uri = `asset://${'c'.repeat(64)}.html`
    expect(taskArtifacts.sourceTravelsTo('github', uri, 'report.html')).toBe(false)
    expect(taskArtifacts.sourceTravelsTo('jira', uri, 'report.html')).toBe(true)
    expect(taskArtifacts.sourceTravelsTo(null, uri, 'report.html')).toBe(true)
  })

  test('the comment is the durable record: local asset references, never provider URLs', () => {
    const previewUri = `asset://${'a'.repeat(64)}.png`
    const sourceUri = `asset://${'b'.repeat(64)}.html`
    const withSource = taskArtifacts.artifactCommentBody({
      title: 'Latency report',
      previewUri,
      sourceUri,
      sourceFileName: 'Latency report.html',
      includeSource: true,
    })
    expect(withSource).toContain(`![Latency report](${previewUri})`)
    expect(withSource).toContain(`[Latency report.html](${sourceUri})`)

    const stillOnly = taskArtifacts.artifactCommentBody({
      title: 'Latency report',
      previewUri,
      sourceUri,
      sourceFileName: 'Latency report.html',
      includeSource: false,
    })
    expect(stillOnly).toContain(`![Latency report](${previewUri})`)
    expect(stillOnly).not.toContain(sourceUri)
    expect(stillOnly).toContain('Solus')
  })

  test('only an artifact work can be attached', async () => {
    // WHY: a document has no render to take a still of; refusing names the
    // kind rather than drawing an empty page.
    const record = await taskStore.createTask('local', { title: 'Report latency' })
    const doc = await works.createWork('local', 'Notes', 'doc', '# Notes', 'Notes', undefined, 'claude-code', '~')
    await expect(taskArtifacts.attachArtifactToTask('local', record.id, doc.id)).rejects.toThrow(/is a doc, not an artifact/)
    await expect(taskArtifacts.attachArtifactToTask('local', record.id, 'missing-work')).rejects.toThrow(/no longer exists/)
  })
})
