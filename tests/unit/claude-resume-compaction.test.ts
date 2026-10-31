import { describe, expect, test } from 'bun:test'
import { resumeCompactionDialog } from '@solus/server/execution/agents/claude/claude-resume-compaction'

const request = { dialogKind: 'resume_return', payload: {} }
const options = { requestId: 'resume-test', signal: new AbortController().signal }
describe('Claude resume compaction', () => {
  test('never continues with the complete history and does not ask', async () => {
    const callback = resumeCompactionDialog('off', async () => { throw new Error('Must not ask') })
    expect(await callback(request, options)).toEqual({ behavior: 'completed', result: 'continue' })
    expect(await callback({ ...request, dialogKind: 'future-dialog' }, options)).toEqual({ behavior: 'cancelled' })
  })
  test('on return uses the normal question path and preserves the chosen action', async () => {
    const callback = resumeCompactionDialog('onReturn', async (name, input) => {
      expect(name).toBe('AskUserQuestion')
      return { behavior: 'allow', updatedInput: { ...input, answers: { 'Compact this session before you continue?': 'Compact history' } } }
    })
    expect(await callback(request, options)).toEqual({ behavior: 'completed', result: 'compact' })
  })
  test('a cancelled question does not compact the session', async () => {
    const callback = resumeCompactionDialog('onReturn', async () => ({ behavior: 'deny', message: 'Cancelled' }))
    expect(await callback(request, options)).toEqual({ behavior: 'cancelled' })
  })
})
