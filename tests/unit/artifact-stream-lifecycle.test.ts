import { afterEach, expect, test } from 'bun:test'
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
  const tracker = new WorkStreamTracker(
    { finalizeProvisional() {} } as WorksStore,
    {} as RouterStore,
  )
  const messages: Message[] = []
  const session = { id: 's', messages, run: { workingDirectory: '/fixture', serverId: 'host' } } as Session
  return { tracker, session, messages }
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
