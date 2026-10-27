import { afterEach, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

test('file calls keep their path in the live row until the result arrives', async () => {
  // WHY: Claude sends the path when the input stream ends. Finishing the call
  // then hides that path before the live activity row can show it.
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const session = {
    id: 'session-1', status: 'running', messages: [], outboundPrompts: [],
    run: { location: folderLocation({ serverId: 'local', path: '/repo' }) },
  } as unknown as Session
  const reducer = new SessionEventReducer({
    sessions: { byId: { 'session-1': session } },
    registry: { tabs: {}, sessionFor: () => undefined, tabIdsBySession: new Map() },
    settings: { rateLimitBehavior: 'ask' },
    workStreamTracker: { sweep: () => {}, beginWorkStream: () => {} },
    addChangedFilesFromMessage: () => {},
    onTurnSettled: () => {}, refreshTurnSnapshots: () => {},
    isSessionVisible: () => false, publishSessionViewed: () => {},
    closePlanModal: () => {}, playNotificationIfHidden: () => {}, log: () => {},
  } as any)

  for (const [index, toolName] of ['Read', 'Edit', 'Write', 'NotebookRead', 'NotebookEdit'].entries()) {
    const toolId = `file-${index}`
    const toolInput = toolName.startsWith('Notebook')
      ? '{"notebook_path":"/repo/notes.ipynb"}'
      : '{"file_path":"/repo/src/App.svelte"}'
    reducer.apply('session-1', { type: 'tool_call', toolName, toolId, index })
    reducer.apply('session-1', { type: 'tool_call_complete', index, toolInput })
    expect(session.messages[index].toolStatus).toBe('running')
    expect(session.messages[index].toolInput).toBe(toolInput)
    reducer.apply('session-1', { type: 'tool_result', toolUseId: toolId, content: '' })
    expect(session.messages[index].toolStatus).toBe('completed')
  }
})
