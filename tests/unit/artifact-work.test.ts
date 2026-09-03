import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { NormalizedEvent } from '@solus/contracts/types'
import { artifactPreview, resolveArtifactTitle, workPreview } from '@solus/contracts/work-preview'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskModule = typeof import('@solus/server/tasks/task')
type WorksModule = typeof import('@solus/server/folio/works')
type ArtifactToolsModule = typeof import('@solus/server/folio/artifact-tools')
type WorkToolsModule = typeof import('@solus/server/folio/work-tools')
type TaskArtifactsModule = typeof import('@solus/server/tasks/task-artifacts')

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

const artifactShellSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/artifact/ArtifactShell.svelte'),
  'utf8',
)
const artifactViewSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/artifact/ArtifactView.svelte'),
  'utf8',
)
const webLayoutSource = readFileSync(
  join(import.meta.dir, '../../apps/client/src/components/WebLayout.svelte'),
  'utf8',
)
const workspacePageSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/workspace/WorkspacePage.svelte'),
  'utf8',
)
const workPaneSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/work/WorkPane.svelte'),
  'utf8',
)
const diagramShellSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/diagram/DiagramShell.svelte'),
  'utf8',
)
const diagramShellCss = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/diagram/DiagramShell.css'),
  'utf8',
)
const canvasToolbarSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/diagram/CanvasToolbar.svelte'),
  'utf8',
)
const diagramCommentsSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/diagram/DiagramCommentsPanel.svelte'),
  'utf8',
)

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-artifact-work-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  works = await import('@solus/server/folio/works')
  artifactTools = await import('@solus/server/folio/artifact-tools')
  workTools = await import('@solus/server/folio/work-tools')
  taskArtifacts = await import('@solus/server/tasks/task-artifacts')
})

afterEach(() => {
  db.closeDb()
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

describe('the artifact work surface', () => {
  test('paints the same pane background as other works', () => {
    // WHY: the pane behind a work uses the darker workspace edge colour. A
    // transparent artifact shell exposes it and makes this work type look like
    // a separate page even when the artifact HTML itself is transparent.
    expect(artifactShellSource).toContain('bg-(--solus-container-bg)')
  })

  test('a short render fills its workspace pane without changing transcript renders', () => {
    // WHY: artifact HTML normally reports its content height for transcript
    // cards. A pane must opt into the available height or it leaves the lower
    // part of the workspace as an unrelated dark block.
    expect(artifactShellSource).toContain('<ArtifactView {artifact} fillAvailable skipMotion />')
    expect(artifactViewSource).toContain('class:fill-available={fillAvailable}')
    expect(artifactViewSource).toContain('.artifact-iframe.fill-available')
  })

  test('mobile uses the shared type-aware work route', () => {
    // WHY: routing every work through DocumentModal turns diagram JSON and
    // artifact HTML into document text. WorkPane is the one owner of the
    // diagram, artifact, and document dispatch used on desktop.
    expect(webLayoutSource).toContain('components/work/WorkPane.svelte')
    expect(webLayoutSource).toContain('params={activeWorkRoute.params}')
    expect(webLayoutSource).toContain('paneId={activeWorkRoute.paneId}')
    expect(webLayoutSource).toContain('overlayOpen={!!activePlan || !!activeWorkRoute}')
    expect(webLayoutSource).not.toContain('components/document-modal/DocumentModal.svelte')
  })

  test('the mobile Folio sheet uses the host-aware work opener', () => {
    // WHY: direct route placement can reuse an existing artifact pane and leave
    // Folio visible over it. The canonical opener closes Folio first and the
    // route surface restores host affinity before it reads a host-local id.
    expect(workspacePageSource).toContain('void openItem(target).then(() => peek.close())')
    expect(workspacePageSource).not.toContain('session.openWork(target.id)')
    expect(workPaneSource).toContain('session.worksStore.rememberHost(workId, serverId)')
    expect(workPaneSource).toContain('session.worksStore.ensureContent(workId, "work-pane")')
  })

  test('mobile removes fullscreen expansion but keeps applicable artifact actions visible', () => {
    // WHY: fullscreen expansion duplicates the mobile work surface and can trap
    // the user in an overlay. Image copy remains useful and cannot depend on a
    // hover pass because the iframe or image receives the first tap.
    expect(artifactViewSource).toContain('{#if !runtime.isMobileViewport}')
    expect(artifactViewSource).toContain('if (runtime.isMobileViewport) expanded = false;')
    expect(artifactViewSource).toContain('@media (hover: none), (pointer: coarse)')
    expect(artifactViewSource).toMatch(/\.artifact-actions\s*\{\s*opacity: 1;/)
    expect(artifactViewSource).toMatch(/\.artifact-action\s*\{\s*width: 2\.5rem;\s*height: 2\.5rem;/)
  })

  test('the mobile Folio list opens HTML artifacts instead of previewing their source', () => {
    // WHY: an HTML artifact's content is implementation markup, not a useful
    // preview. Its rendered work surface is the first useful mobile destination.
    expect(workspacePageSource).toContain(
      'stacked && !isHtmlArtifact(item) ? peek.raise(item) : openItem(item)',
    )
  })

  test('narrow diagram panes use bottom sheets and preserve invalid source', () => {
    // WHY: a desktop-width inspector leaves no usable canvas on a phone, and
    // parse failure must not present an editable empty diagram that can replace
    // the invalid source on the next save.
    expect(diagramShellSource).toContain('const inspectorUsesBottomSheet')
    expect(diagramShellSource).toContain('data-testid="diagram-load-error"')
    expect(diagramShellSource).toContain('Download JSON')
    expect(diagramShellCss).toContain('@container pane (max-width: 48rem)')
    expect(diagramShellCss).toMatch(/\.diagram-inspector\s*\{[\s\S]*?top: auto;[\s\S]*?height: min\(70%, 34rem\);/)
    expect(diagramCommentsSource).toMatch(/@container pane \(max-width: 48rem\)[\s\S]*?\.diagram-comments/)
  })

  test('phones default to canvas gestures and never show the minimap', () => {
    // WHY: a draggable node claims the touch before the viewport can pan or
    // pinch, and a landscape phone can be wider than the minimap size cutoff.
    // Mobile detection, not current orientation, must own both decisions.
    expect(diagramShellSource).toContain('nodesDraggable={!runtime.isTouchDevice || touchNodeDragEnabled}')
    expect(diagramShellSource).toContain('runtime.isMobileViewport ? null : minimapSize(boardWidth)')
    expect(canvasToolbarSource).toContain('aria-label="Move nodes"')
    expect(canvasToolbarSource).toContain('aria-pressed={touchNodeDragEnabled}')
  })
})

describe('render_artifact persists a work', () => {
  test('create_work automatically links a session-authored work to its task', async () => {
    // WHY: the Link control is the manual way in and out. It must not replace
    // the default filing rule for a work created inside a task-owned session.
    const record = await taskStore.createTask({ title: 'Draft release notes' })
    const task = await tasks.Task.byId(record.id)
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

    const stored = await works.loadWork(artifact.workId)
    expect(stored).toMatchObject({
      type: 'artifact',
      title: 'Latency & throughput',
      content: HTML,
      sessionIds: [SESSION_ID],
    })
    expect((await works.listWorks()).map((work) => work.id)).toContain(artifact.workId)
  })

  test('the work links to the task the rendering session is working', async () => {
    // WHY: a document written by a session on a task appears on that task;
    // an artifact rendered by the same session must not be the one thing
    // that does not.
    const record = await taskStore.createTask({ title: 'Report latency' })
    const task = await tasks.Task.byId(record.id)
    await task.linkSession(SESSION_ID)

    const emitted: Array<{ workId: string }> = []
    await artifactTools.executeArtifactTool(
      { html: HTML, title: 'Latency report' },
      {
        ctx: { sessionId: SESSION_ID, agentProvider: 'claude-code', cwd: '~' },
        onArtifact: (artifact) => emitted.push(artifact),
      },
    )

    const details = await task.details()
    expect(details.links).toContainEqual(
      expect.objectContaining({ kind: 'work', targetKey: emitted[0].workId, liveStatus: 'artifact' }),
    )
  })

  test('empty html is refused before anything is written', async () => {
    const result = await artifactTools.executeArtifactTool({ html: '   ' })
    expect(result.ok).toBe(false)
    expect(await works.listWorks()).toHaveLength(0)
  })

  test('the agent tool emits artifact_created with the work behind it', async () => {
    const events: NormalizedEvent[] = []
    const result = await artifactTools.renderArtifactAgentTool.execute(
      { html: HTML, title: 'Latency report' },
      {
        sessionId: () => SESSION_ID,
        solusSessionId: () => undefined,
        provider: 'claude-code',
        cwd: '~',
        emit: (event: NormalizedEvent) => events.push(event),
      } as unknown as Parameters<typeof artifactTools.renderArtifactAgentTool.execute>[1],
    )
    expect(result.ok).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'artifact_created', kind: 'html', html: HTML, title: 'Latency report' })
    expect(events[0].type === 'artifact_created' && events[0].workId).toBeTruthy()
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
    const record = await taskStore.createTask({ title: 'Report latency' })
    const doc = await works.createWork('Notes', 'doc', '# Notes', 'Notes', undefined, 'claude-code', '~')
    await expect(taskArtifacts.attachArtifactToTask(record.id, doc.id)).rejects.toThrow(/is a doc, not an artifact/)
    await expect(taskArtifacts.attachArtifactToTask(record.id, 'missing-work')).rejects.toThrow(/no longer exists/)
  })
})
