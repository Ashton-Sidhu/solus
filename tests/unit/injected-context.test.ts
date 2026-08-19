import { describe, expect, test } from 'bun:test'
import { stripInjectedContext } from '@solus/server/agents/utils'
import { formatTaskContext } from '@solus/server/tasks/task-context'
import type { TaskDetails } from '@solus/contracts/task-types'

const details = {
  task: {
    id: '01KZ4TSYMQRX31D1DK5AAEW5TR',
    title: 'Task System Testing',
    status: 'in_progress',
    body: 'Check the packet round-trips.',
    labels: [],
    assignee: null,
    branch: 'main',
    projectKey: '/Users/sidhu/solus',
    parentId: null,
    pr: null,
  },
  comments: [{ author: 'ashton', body: 'still broken on reload' }],
  subtasks: [],
  links: [],
  events: [],
} as unknown as TaskDetails

describe('stripInjectedContext', () => {
  test('keeps the typed prompt of a task-backed session', () => {
    // WHY: the task packet is prepended, so treating it like the appended blocks
    // erases the user's turn — and a transcript with no user turn folds its whole
    // history behind one activity row on reload.
    const prompt = `${formatTaskContext(details)}\n\nfix the scroll bug`

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })

  test('a packet with nothing typed after it leaves no user turn', () => {
    expect(stripInjectedContext(formatTaskContext(details))).toBe('')
  })

  test('still drops the blocks appended after the typed prompt', () => {
    const prompt = [
      'fix the scroll bug',
      '',
      '[Working On Task "Task System Testing" (task_id: 01KZ4TSYMQRX31D1DK5AAEW5TR)]',
      'Call read_task with task_id "01KZ4TSYMQRX31D1DK5AAEW5TR" to read the latest status, comments, and linked PRs; call update_task_status to move it.',
    ].join('\n')

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })

  test('strips both a leading packet and a trailing reference block', () => {
    const prompt = [
      formatTaskContext(details),
      '',
      'fix the scroll bug',
      '',
      '[Referenced Work: "Notes" (work_id: w1)]',
    ].join('\n')

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })
})

describe('task lifecycle work contracts', () => {
  test('moderate keeps Done under user control by default', () => {
    const packet = formatTaskContext(details)
    expect(packet).toContain('Do not move it to done; the user closes completed work.')
  })

  test('none tells the agent not to change task status', () => {
    const packet = formatTaskContext(details, null, [], 'none')
    expect(packet).toContain("Do not change this task's status")
    expect(packet).not.toContain('use comment_task and update_task_status')
  })

  test('autonomous permits the agent to finish the task', () => {
    const packet = formatTaskContext(details, null, [], 'autonomous')
    expect(packet).toContain('or done when the work is complete without review')
  })
})
