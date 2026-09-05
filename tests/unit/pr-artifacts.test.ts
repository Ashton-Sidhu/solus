import { describe, expect, test } from 'bun:test'
import type { TaskLink } from '@solus/contracts/task-types'
import { prArtifactsFrom } from '../../packages/workspace-ui/src/components/pr-review/lib/pr-artifacts'

function link(targetKey: string, liveStatus: string, title = targetKey, linkedAt = 0): TaskLink {
  return {
    taskId: 't',
    kind: 'work',
    targetScope: '',
    targetKey,
    title,
    liveStatus,
    createdBy: 'agent',
    linkedAt,
  }
}

describe('the artifacts behind a pull request', () => {
  test('two tasks linking the same work yield one entry', () => {
    // WHY: a review and its follow-up are two tasks on one pull request, and
    // they routinely link the same render. Listing it twice would read as two
    // different artifacts.
    const artifacts = prArtifactsFrom([
      { taskId: 't1', taskTitle: 'Review', links: [link('work-1', 'artifact', 'work-1', 500)] },
      { taskId: 't2', taskTitle: 'Follow-up', links: [link('work-1', 'artifact', 'work-1', 900)] },
    ])

    // The link time is what places the render on the timeline.
    expect(artifacts).toEqual([
      { workId: 'work-1', title: 'work-1', taskId: 't1', taskTitle: 'Review', linkedAt: 500 },
    ])
  })

  test('only artifact works are listed', () => {
    // WHY: a task on a pull request usually links a plan and a document too.
    // Neither has a render, so neither belongs in a section of renders.
    const artifacts = prArtifactsFrom([
      {
        taskId: 't1',
        taskTitle: 'Review',
        links: [
          link('work-doc', 'doc'),
          link('work-diagram', 'diagram'),
          link('work-art', 'artifact'),
          { ...link('plan-1', 'draft'), kind: 'plan' },
        ],
      },
    ])

    expect(artifacts.map((artifact) => artifact.workId)).toEqual(['work-art'])
  })

  test('a live rename wins over the snapshot title', () => {
    const artifacts = prArtifactsFrom([
      {
        taskId: 't1',
        taskTitle: 'Review',
        links: [{ ...link('work-1', 'artifact', 'Old name'), liveTitle: 'Latency report' }],
      },
    ])

    expect(artifacts[0].title).toBe('Latency report')
  })

  test('no tasks means no section', () => {
    expect(prArtifactsFrom([])).toEqual([])
  })
})

test('PR task selection includes repository and host identity', async () => {
  const { taskLinksToPr } = await import('../../packages/workspace-ui/src/components/pr-review/lib/pr-artifacts')
  const url = 'https://github.com/team/first/pull/12'
  const links = [{ number: 12, targetScope: 'github.com/team/first' }]
  expect(taskLinksToPr(links, 'host-a', 'host-a', url)).toBe(true)
  expect(taskLinksToPr(links, 'host-b', 'host-a', url)).toBe(false)
  expect(taskLinksToPr(links, 'host-a', 'host-a', 'https://github.com/team/second/pull/12')).toBe(false)
  expect(taskLinksToPr([{ number: 12 }], 'host-a', 'host-a', url)).toBe(false)
  expect(taskLinksToPr([{ number: 12, targetScope: '/legacy/checkout', url }], 'host-a', 'host-a', url)).toBe(true)
})
