import { expect, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { artifactUpdateFromHistory } from '../../packages/workspace-ui/src/contexts/workspace/artifact-history'

test('known artifact updates rebuild from input without requiring a receipt, like new renders', () => {
  const tool: WireSessionLoadMessage = { role: 'tool', content: '', timestamp: 1, toolInput: JSON.stringify({ work_id: 'work', content: '<p>Historical</p>' }) }
  const getWork = () => ({ type: 'artifact', content: '<p>Current</p>' } as Work)
  expect(artifactUpdateFromHistory(tool, tool, getWork)?.artifact?.html).toBe('<p>Historical</p>')
  expect(artifactUpdateFromHistory(tool, { ...tool, status: 'error' }, getWork)).toBeUndefined()
  expect(artifactUpdateFromHistory({ ...tool, toolStatus: 'running' }, tool, getWork)).toBeUndefined()
  expect(artifactUpdateFromHistory(tool, tool, () => undefined)).toBeUndefined()
})
