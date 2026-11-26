import { describe, expect, mock, test } from 'bun:test'
import type { TaskDataStore } from '@solus/client-core/task-data'
import type { TaskReaction } from '@solus/contracts/task-data'

mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { error: () => {} } }))
const { TaskPageReactions, taskReactions } = await import(
  '../../packages/workspace-ui/src/components/tasks/task-page/lib/task-reactions.svelte'
)

const ISSUE_ID = 'I_1'
const reactions: TaskReaction[] = [
  { targetId: ISSUE_ID, content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
  { targetId: 'C_1', content: 'HEART', count: 1, viewerHasReacted: true }
]

function fakeData() {
  const calls: Array<[string, string, boolean]> = []
  let settle: () => void = () => {}
  const data = {
    react(targetId: string, content: string, add: boolean) {
      calls.push([targetId, content, add])
      return new Promise<void>((resolve) => (settle = resolve))
    }
  } as unknown as TaskDataStore
  return { data, calls, settle: () => settle() }
}

describe('issue reactions', () => {
  test('each target shows only its own reactions, as a pull request bar draws them', () => {
    expect(taskReactions(reactions, ISSUE_ID, true)).toEqual({
      viewerCanReact: true,
      groups: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false, actors: [] }]
    })
    expect(taskReactions(reactions, 'C_1', false).groups.map((group) => group.content)).toEqual(['HEART'])
  })

  test('a toggle on the issue writes to the issue and shows at once until the write settles', async () => {
    const fake = fakeData()
    const page = new TaskPageReactions(() => ({ data: fake.data, issueId: ISSUE_ID }))
    const read = taskReactions(reactions, ISSUE_ID, true)
    page.toggle(null, 'THUMBS_UP', read)
    expect(fake.calls).toEqual([[ISSUE_ID, 'THUMBS_UP', true]])
    expect(page.shown(null, read)?.groups[0]).toMatchObject({ count: 3, viewerHasReacted: true })
    fake.settle()
    await Bun.sleep(0)
    expect(page.shown(null, read)).toBe(read)
  })

  test('a held reaction on a comment is taken back', () => {
    const fake = fakeData()
    const page = new TaskPageReactions(() => ({ data: fake.data, issueId: ISSUE_ID }))
    page.toggle('C_1', 'HEART', taskReactions(reactions, 'C_1', true))
    expect(fake.calls).toEqual([['C_1', 'HEART', false]])
  })

  test('a page with no task data cannot write', () => {
    const page = new TaskPageReactions(() => ({ data: undefined, issueId: ISSUE_ID }))
    expect(page.canWrite).toBe(false)
  })
})
