import { expect, test } from 'bun:test'
import type { Message, Work } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { workUpdateFromHistory, loadArtifactFileBodies, loadArtifactHtml } from '../../packages/workspace-ui/src/contexts/workspace/artifact-history'
import { deferSavedArtifactHtml, selectSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'

test('known artifact updates rebuild from input without requiring a receipt, like new renders', () => {
  const tool: WireSessionLoadMessage = { role: 'tool', content: '', timestamp: 1, toolInput: JSON.stringify({ work_id: 'work', content: '<p>Historical</p>' }) }
  const getWork = () => ({ type: 'artifact', content: '<p>Current</p>' } as Work)
  expect(workUpdateFromHistory(tool, tool, getWork)?.artifact?.html).toBe('<p>Historical</p>')
  expect(workUpdateFromHistory(tool, { ...tool, status: 'error' }, getWork)).toBeUndefined()
  expect(workUpdateFromHistory({ ...tool, toolStatus: 'running' }, tool, getWork)).toBeUndefined()
  expect(workUpdateFromHistory(tool, tool, () => undefined)).toBeUndefined()
})

test('an html_path update replays the revision that call wrote, never today\'s body', async () => {
  // WHY: the host read the file, so the stored input holds only a path. The
  // card must show what this call wrote, as an inline call does: the revision
  // at the receipt's content version, not the work's current content.
  const tool: WireSessionLoadMessage = { role: 'tool', content: '', timestamp: 1, toolId: 'update-1', toolName: 'update_work', toolInput: JSON.stringify({ work_id: 'work', html_path: 'chart/bundle.html', expected_content_version: 2 }) }
  const result: WireSessionLoadMessage = { role: 'tool_result', content: '', timestamp: 2, toolResultForId: 'update-1', artifactWorkRef: { workId: 'work', title: 'Chart', contentVersion: 3 } }
  const read: Array<[string, number]> = []
  const bodyAtVersion = async (workId: string, contentVersion: number) => {
    read.push([workId, contentVersion])
    return `<p>Version ${contentVersion}</p>`
  }

  const bodies = await loadArtifactFileBodies(bodyAtVersion, [tool, result])
  expect(read).toEqual([['work', 3]])
  expect(workUpdateFromHistory(tool, result, () => undefined, bodies.get('update-1'))?.artifact?.html).toBe('<p>Version 3</p>')
  // A revision the host cannot answer leaves no card rather than an empty one.
  expect(workUpdateFromHistory(tool, result, () => undefined, undefined)).toBeUndefined()
})

for (const workType of ['doc', 'slides', 'diagram'] as const) {
  test(`${workType} update cards require a successful save receipt`, () => {
    const tool: WireSessionLoadMessage = { role: 'tool', content: '', timestamp: 1, toolInput: JSON.stringify({ work_id: 'work', content: 'New content' }) }
    const getWork = () => ({ type: workType, title: 'Saved work' })
    const receipt = { ...tool, workUpdateSucceeded: true, workContentVersion: 3 }
    expect(workUpdateFromHistory(tool, receipt, getWork)?.workRef).toEqual({ workId: 'work', title: 'Saved work', workType, contentVersion: 3 })
    expect(workUpdateFromHistory(tool, tool, getWork)).toBeUndefined()
    expect(workUpdateFromHistory(tool, { ...receipt, status: 'error' }, getWork)).toBeUndefined()
  })
}

test('a page asked without artifact HTML still shows the render each call saved', async () => {
  // WHY: a compiled render is 100-300 KB and a page carries every revision, so
  // the host leaves a saved render's HTML out of the page. The frame must still
  // show what that call rendered: the work's revision at the receipt's version,
  // or the call's own input when the work cannot answer.
  const html = '<p>Dashboard v1</p>'
  const tool: WireSessionLoadMessage = { role: 'tool', content: '', timestamp: 1, toolId: 'render-1', toolName: 'mcp__solus__render_artifact', toolInput: JSON.stringify({ title: 'Dashboard', html }) }
  const saved: WireSessionLoadMessage = { role: 'tool_result', content: '', timestamp: 2, toolResultForId: 'render-1', artifactWorkRef: { workId: 'work', title: 'Dashboard', contentVersion: 1 } }
  const unsaved: WireSessionLoadMessage = { ...tool, toolId: 'render-2' }
  const [deferred, , kept] = deferSavedArtifactHtml([tool, saved, unsaved])
  expect(JSON.parse(deferred.toolInput!)).toEqual({ title: 'Dashboard' })
  expect(deferred.toolInputKey).toMatch(/^[a-f0-9]{64}$/)
  // The full input stays loadable under the key the page names.
  expect(selectSessionToolInputs([tool], [deferred.toolInputKey!])).toEqual([{ key: deferred.toolInputKey!, toolInput: tool.toolInput! }])
  // A render the work did not save has nowhere else to read from.
  expect(kept).toBe(unsaved)
  // The newest render is the frame on screen when the conversation opens: its
  // HTML stays in the page so it does not wait for a read.
  const [newest] = deferSavedArtifactHtml([tool, saved])
  expect(newest).toBe(tool)

  const historyHtml = { serverId: 'host', sessionId: 'session', provider: 'claude-code' as const, key: deferred.toolInputKey! }
  const fromWork: Message = { id: 'a', role: 'assistant', content: '', timestamp: 3, artifact: { kind: 'html', historyHtml }, workRef: { workId: 'work', title: 'Dashboard', workType: 'artifact', contentVersion: 1 } }
  await loadArtifactHtml(fromWork, { bodyAtVersion: async (workId, version) => workId === 'work' && version === 1 ? html : null })
  expect(fromWork.artifact).toEqual({ kind: 'html', html })

  const fromInput: Message = { ...fromWork, id: 'b', artifact: { kind: 'html', historyHtml: { ...historyHtml } } }
  await loadArtifactHtml(fromInput, {
    bodyAtVersion: async () => null,
    apiFor: () => ({ loadSessionToolInputs: async ({ keys }) => selectSessionToolInputs([tool], keys) }),
  })
  expect(fromInput.artifact).toEqual({ kind: 'html', html })
})

