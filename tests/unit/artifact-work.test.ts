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
        sessionId: () => undefined,
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
    await works.markWorkMoved('local', workId, (await works.exportWorkForCloud('local', workId)).fingerprint, 'org-1')

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

describe('render_artifact checks a page before and after it is shown', () => {
  const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const SCREENSHOT = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`
  type Preview = Awaited<ReturnType<typeof import('@solus/server/data/works/artifact-preview')['previewArtifactHtml']>>
  const ctx = () => ({ sessionId: SESSION_ID, agentProvider: 'claude-code' as const, cwd: dataDir })
  const fakePreview = (result: Partial<Preview>, seen: Array<{ html: string; width?: number; appearance?: 'light' | 'dark' }> = []) =>
    async (input: { html: string; width?: number; appearance?: 'light' | 'dark' }): Promise<Preview> => {
      seen.push(input)
      return { screenshot: SCREENSHOT, width: input.width ?? 760, appearance: input.appearance ?? 'light', contentHeight: 412, console: [], missingImages: [], ...result }
    }

  test('a preview saves nothing and shows nothing, and reports what the page did', async () => {
    // WHY: the agent checks a page it may never keep. A preview that wrote a
    // work or rendered a card would put drafts in front of the user.
    const emitted: unknown[] = []
    const seen: Array<{ html: string; width?: number; appearance?: 'light' | 'dark' }> = []
    const result = await artifactTools.executeArtifactTool(
      { html: HTML, preview: true, preview_width: 390, preview_appearance: 'dark' },
      {
        ctx: ctx(),
        onArtifact: (artifact) => emitted.push(artifact),
        preview: fakePreview({
          console: [{ at: 1, level: 'error', text: 'Uncaught ReferenceError: chart is not defined (line 4)' }],
          missingImages: ['/tmp/missing-shot.png'],
        }, seen),
      },
    )
    expect(result.ok).toBe(true)
    expect(emitted).toHaveLength(0)
    expect(await works.listWorks('local')).toHaveLength(0)
    expect(seen).toEqual([{ html: HTML, width: 390, appearance: 'dark' }])
    expect(result.text).toContain('the page is 412px tall')
    expect(result.text).toContain('[error] Uncaught ReferenceError: chart is not defined (line 4)')
    expect(result.text).toContain('/tmp/missing-shot.png')
    // The screenshot is a file the agent can read, on this host.
    const screenshotPath = /screenshot: (\S+)/.exec(result.text)![1]
    expect(await Bun.file(screenshotPath).exists()).toBe(true)
  })

  test('a saved page that raises errors says so instead of failing silently', async () => {
    const result = await artifactTools.executeArtifactTool(
      { html: HTML },
      { ctx: ctx(), preview: fakePreview({ console: [{ at: 1, level: 'error', text: 'Failed to load https://cdn.example/chart.js' }, { at: 2, level: 'log', text: 'drawn' }] }) },
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('The page raised errors when rendered')
    expect(result.text).toContain('Failed to load https://cdn.example/chart.js')
    // Ordinary logs are the agent's own checks, not problems with the save.
    expect(result.text).not.toContain('drawn')
  })

  test('a saved artifact carries its local images, so any client can show them', async () => {
    // WHY: a saved work opens on another device and in a shared link, where a
    // path on this host means nothing.
    const imagePath = join(dataDir, 'shot.png')
    writeFileSync(imagePath, ONE_PIXEL_PNG)
    const emitted: Array<{ html: string }> = []
    await artifactTools.executeArtifactTool(
      { html: `<style>p{}</style><img src="${imagePath}">` },
      { ctx: ctx(), onArtifact: (artifact) => emitted.push(artifact), preview: fakePreview({}) },
    )
    expect(emitted[0].html).toContain('src="data:image/png;base64,')
    expect(emitted[0].html).not.toContain(imagePath)
  })

  test('the server preview renders the page in the Solus theme, at the size it needs', async () => {
    // WHY: an agent fixes what the preview shows. A preview in other colours,
    // or cut to one screen, would have it fix a page the reader never sees.
    const { setBrowserHeadlessHost } = await import('@solus/server/browser/surface-driver')
    const { previewArtifactHtml } = await import('@solus/server/data/works/artifact-preview')
    const opened: string[] = []
    const viewports: Array<{ width: number; height: number }> = []
    let disposed = false
    const driver = {
      evaluate: async (expression: string) => (expression.includes('getBoundingClientRect') ? '1234' : '"ok"'),
      applyEmulation: async (emulation: { viewport: { width: number; height: number } }) => { viewports.push(emulation.viewport) },
      captureScreenshot: async () => SCREENSHOT,
      consoleEntries: () => [{ at: 1, level: 'error' as const, text: 'Uncaught TypeError: x is null (line 9)' }],
      dispose: async () => { disposed = true },
    }
    setBrowserHeadlessHost({
      open: async (request) => {
        opened.push(Buffer.from(request.url.split(',')[1], 'base64').toString('utf8'))
        return driver as unknown as Awaited<ReturnType<NonNullable<ReturnType<typeof import('@solus/server/browser/surface-driver')['browserHeadlessHost']>>['open']>>
      },
    })
    try {
      const imagePath = join(dataDir, 'preview-shot.png')
      writeFileSync(imagePath, ONE_PIXEL_PNG)
      const preview = await previewArtifactHtml({ html: `<img src="${imagePath}"><img src="/no/such.png">`, appearance: 'dark' })
      const page = opened[0]
      expect(page).toContain('color-scheme:dark')
      expect(page).toContain('--background:#262522fa')
      expect(page).toContain('src="data:image/png;base64,')
      expect(preview.missingImages).toEqual(['/no/such.png'])
      // The capture grows to the page rather than stopping at one screen.
      expect(viewports.at(-1)).toMatchObject({ width: 760, height: 1234 })
      expect(preview.contentHeight).toBe(1234)
      expect(preview.console[0].text).toContain('TypeError')
      expect(disposed).toBe(true)
    } finally {
      setBrowserHeadlessHost(null)
    }
  })
})
