import { afterEach, expect, test } from 'bun:test'
import { createArtifactRevisionIndexer } from '../../packages/workspace-ui/src/components/conversation/lib/artifact-revisions'
import type { Message, Session } from '@solus/contracts/types'
import type { WorksStore } from '../../packages/workspace-ui/src/contexts/works/works.store.svelte'
import type { RouterStore } from '../../packages/workspace-ui/src/contexts/workspace/routing/router.store.svelte'

const previousState = Object.getOwnPropertyDescriptor(globalThis, '$state')
afterEach(() => {
  if (previousState) Object.defineProperty(globalThis, '$state', previousState)
  else Reflect.deleteProperty(globalThis, '$state')
})

async function fixture() {
  Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T) => value })
  const { WorkStreamTracker } = await import('../../packages/workspace-ui/src/contexts/workspace/work-stream-tracker.svelte')
  let savedWorkReplacements = 0
  const tracker = new WorkStreamTracker(
    { finalizeProvisional() { savedWorkReplacements++ }, get() { return undefined } } as WorksStore,
    {} as RouterStore,
  )
  const messages: Message[] = []
  const session = { id: 's', messages, run: { workingDirectory: '/fixture', serverId: 'host' } } as Session
  return { tracker, session, messages, replacements: () => savedWorkReplacements }
}

test('interleaved artifact calls retain their own preview and completion', async () => {
  const { tracker, session, messages } = await fixture()
  tracker.beginToolArtifacts(session, 'render_artifact', 'codex', 'first')
  tracker.beginToolArtifacts(session, 'render_artifact', 'codex', 'second')
  tracker.updateStreamingArtifact(session, 'render_artifact', '{"html":"<body>First', 'first')
  tracker.updateStreamingArtifact(session, 'render_artifact', '{"html":"<body>Second', 'second')
  expect(messages.map((m) => m.artifact?.html)).toEqual(['<body>First', '<body>Second'])
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', toolId: 'second', html: '<body>Second done</body>' })
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', toolId: 'first', html: '<body>First done</body>' })
  expect(messages.map((m) => m.artifact?.html)).toEqual(['<body>First done</body>', '<body>Second done</body>'])
  tracker.sweep(session)
  expect(messages).toHaveLength(2)
})

test('a failed call cannot take a later call or an unrelated image', async () => {
  const { tracker, session, messages } = await fixture()
  tracker.beginToolArtifacts(session, 'render_artifact', 'claude-code', 'failed')
  tracker.failArtifact(session, 'failed')
  expect(messages).toHaveLength(0)
  tracker.beginToolArtifacts(session, 'render_artifact', 'claude-code', 'retry')
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'image', path: '/fixture/image.png' })
  expect(messages[0].artifact?.pending).toBe(true)
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', toolId: 'retry', html: '<p>Done</p>' })
  expect(messages[0].artifact?.html).toBe('<p>Done</p>')
  expect(messages[1].artifact?.kind).toBe('image')
})

test('saved updates append snapshots and ignore repeated or stale delivery', async () => {
  const { tracker, session, messages } = await fixture()
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', workId: 'work', title: 'Original', html: '<p>One</p>' })
  const original = messages[0]
  const update = { type: 'work_updated' as const, workId: 'work', title: 'Renamed', docType: 'artifact' as const, content: '<p>Two</p>', updatedAt: '2026-09-18T10:00:00Z' }
  tracker.updateArtifact(session, update)
  tracker.updateArtifact(session, update)
  tracker.updateArtifact(session, { ...update, updatedAt: '2026-09-18T09:00:00Z' })
  tracker.updateArtifact(session, { ...update, docType: 'doc' })
  tracker.sweep(session)
  expect(messages).toHaveLength(2)
  expect(messages[0]).toBe(original)
  expect(original.artifact?.html).toBe('<p>One</p>')
  expect(original.workRef?.title).toBe('Original')
  expect(messages[1].artifact?.html).toBe('<p>Two</p>')
  expect(messages[1].workRef?.workId).toBe('work')
})

for (const provider of ['claude-code', 'codex'] as const) {
  test(`${provider} updates stream and complete their own cards like new renders`, async () => {
    const { tracker, session, messages } = await fixture()
    tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', workId: 'work', html: '<body>Original</body>' })
    const tool = provider === 'codex' ? 'update_work' : 'mcp__solus__update_work'
    tracker.updateStreamingArtifact(session, tool, '{"work_id":"work",', 'first')
    expect(messages[1].artifact?.pending).toBe(true)
    tracker.updateStreamingArtifact(session, tool, '{"work_id":"work","content":"<body>First', 'first')
    tracker.updateStreamingArtifact(session, tool, '{"work_id":"work","content":"<body>Second', 'second')
    expect(messages[1].artifact?.streaming).toBe(true)
    tracker.updateArtifact(session, { type: 'work_updated', toolId: 'second', workId: 'work', title: 'Updated', docType: 'artifact', content: '<body>Second done</body>', updatedAt: '2026-09-22T00:00:00Z' })
    expect(messages[1].artifact?.streaming).toBe(true)
    expect(messages[2].artifact?.html).toBe('<body>Second done</body>')
    expect(messages[2].artifact?.streaming).toBe(false)
    tracker.failArtifact(session, 'first')
    tracker.sweep(session)
    expect(messages.map((message) => message.artifact?.html)).toEqual(['<body>Original</body>', '<body>Second done</body>'])
  })
}

test('touch clients keep an update skeleton until its own save completes', async () => {
  const { tracker, session, messages } = await fixture()
  const { runtime } = await import('../../packages/workspace-ui/src/contexts/app/runtime.svelte')
  const wasTouch = runtime.isTouchDevice
  runtime.isTouchDevice = true
  try {
    tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', workId: 'work', html: '<p>Original</p>' })
    tracker.updateStreamingArtifact(session, 'update_work', '{"work_id":"work","content":"<body>New', 'update')
    expect(messages[1].artifact?.pending).toBe(true)
    expect(messages[1].artifact?.html).toBeUndefined()
    tracker.updateArtifact(session, { type: 'work_updated', toolId: 'update', workId: 'work', title: 'New', docType: 'artifact', content: '<p>New</p>', updatedAt: '2026-09-22T00:00:00Z' })
    expect(messages).toHaveLength(2)
    expect(messages[1].artifact?.pending).toBe(false)
    expect(messages[1].artifact?.html).toBe('<p>New</p>')
  } finally {
    runtime.isTouchDevice = wasTouch
  }
})

test('update lifecycle preserves the revision index and leaves saved work metadata to its store', async () => {
  const { tracker, session, messages, replacements } = await fixture()
  const index = createArtifactRevisionIndexer()
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', workId: 'work', title: 'V1', html: '<p>One</p>' })
  const first = index(messages)
  const original = first.get('work:work')![0]
  tracker.updateStreamingArtifact(session, 'update_work', '{"work_id":"work","content":"<body>Two', 'update')
  expect(index(messages)).toBe(first)
  const event = { type: 'work_updated' as const, toolId: 'update', workId: 'work', title: 'V2', docType: 'artifact' as const, content: '<p>Two</p>', updatedAt: '2026-09-22T00:00:00Z' }
  tracker.updateArtifact(session, event)
  expect(replacements()).toBe(1)
  const revisions = index(messages).get('work:work')!
  expect(revisions.map(entry => entry.html)).toEqual(['<p>One</p>', '<p>Two</p>'])
  expect(revisions[0]).toEqual(original)
  expect(revisions.at(-1)?.messageId).toBe(messages[1].id)
  tracker.updateArtifact(session, event)
  expect(messages).toHaveLength(2)
  tracker.updateStreamingArtifact(session, 'update_work', '{"work_id":"work","content":"<body>Failed', 'failed')
  tracker.failArtifact(session, 'failed')
  expect(index(messages).get('work:work')).toBe(revisions)
})

test('a cloud-owned save completes its artifact update card although it reports doc and no title', async () => {
  // WHY: a cloud-owned host cannot read the row it updates, so its event says
  // `doc` with an empty title. Dropping it left the skeleton spinning until
  // turn end and the revision never joined the chain.
  const { tracker, session, messages } = await fixture()
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', workId: 'work', title: 'Chart', html: '<p>One</p>' })
  tracker.updateStreamingArtifact(session, 'update_work', '{"work_id":"work"', 'cloud')
  tracker.updateArtifact(session, { type: 'work_updated', toolId: 'cloud', workId: 'work', title: '', docType: 'doc', content: '<p>Two</p>', updatedAt: '2026-09-22T00:00:00Z' })
  expect(messages).toHaveLength(2)
  expect(messages[1].artifact?.pending).toBe(false)
  expect(messages[1].artifact?.html).toBe('<p>Two</p>')
  expect(messages[1].workRef).toEqual({ workId: 'work', title: 'Chart', workType: 'artifact' })
  // Without an update card or a saved artifact, a `doc` update is a document's.
  tracker.updateArtifact(session, { type: 'work_updated', workId: 'other', title: 'Notes', docType: 'doc', content: '# Notes', updatedAt: '2026-09-22T00:00:01Z' })
  expect(messages).toHaveLength(2)
})

test('stale completions remove only their pending card and cannot add revisions', async () => {
  const { tracker, session, messages } = await fixture()
  tracker.finalizeArtifact(session, { type: 'artifact_created', kind: 'html', workId: 'work', html: '<p>One</p>' })
  tracker.updateStreamingArtifact(session, 'update_work', '{"work_id":"work"}', 'old')
  tracker.updateStreamingArtifact(session, 'update_work', '{"work_id":"work"}', 'new')
  const update = { type: 'work_updated' as const, workId: 'work', title: 'New', docType: 'artifact' as const, content: '<p>New</p>', updatedAt: '2026-09-22T00:00:02Z' }
  tracker.updateArtifact(session, { ...update, toolId: 'new' })
  tracker.updateArtifact(session, { ...update, toolId: 'old', updatedAt: '2026-09-22T00:00:01Z' })
  expect(messages).toHaveLength(2)
  expect(messages[1].artifact?.updatedAt).toBe(update.updatedAt)
})
