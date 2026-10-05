import { expect, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { workUpdateFromHistory, loadArtifactFileBodies } from '../../packages/workspace-ui/src/contexts/workspace/artifact-history'

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
