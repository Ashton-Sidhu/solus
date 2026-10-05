import { describe, expect, test } from 'bun:test'
import {
  subagentDetail,
  subagentTargetPath,
} from '@solus/workspace-ui/components/conversation/lib/subagent-card'
import {
  plainDetail,
  subagentLinkStatus,
  subagentStatusLine,
} from '@solus/workspace-ui/components/conversation/lib/agent-link'

describe('the live target', () => {
  test('a long path keeps only the segments that place the file', () => {
    expect(
      subagentTargetPath('/Users/sidhu/solus/.git/solus/worktrees/run-4ktpq/src/renderer/panels/HostPicker.svelte'),
    ).toBe('renderer/panels/HostPicker.svelte')
  })

  test('a bare filename is left as it is', () => {
    expect(subagentTargetPath('host-cache.ts')).toBe('host-cache.ts')
  })

  test('a search pattern is left whole — slicing it into directories would invent a structure', () => {
    expect(subagentTargetPath('cache key/ttl in renderer')).toBe('cache key/ttl in renderer')
  })
})

describe('the sub-agent row', () => {
  // WHY: the detail line is what a reader scans a fan-out for: what each agent
  // is on now, what it found once it lands, and why it stopped.
  test('the detail is the step in flight while running, the answer once done, the reason once failed', () => {
    expect(
      subagentDetail({ state: 'running', activity: 'Reading', target: '/repo/src/renderer/panels/HostPicker.svelte' }),
    ).toBe('Reading renderer/panels/HostPicker.svelte')
    expect(subagentDetail({ state: 'done', activity: 'Reconnect keeps the host.', target: '' })).toBe(
      'Reconnect keeps the host.',
    )
    expect(subagentDetail({ state: 'failed', activity: 'Permission denied for Bash', target: '' })).toBe(
      'Permission denied for Bash',
    )
  })

  // WHY: the dot and the word must agree, in T3 Code's words.
  test('each state has one dot tone and one word', () => {
    expect(subagentLinkStatus('running')).toEqual({ tone: 'live', label: 'Running' })
    expect(subagentLinkStatus('done')).toEqual({ tone: 'done', label: 'Completed' })
    expect(subagentLinkStatus('failed')).toEqual({ tone: 'failed', label: 'Failed' })
  })

  // WHY: a markdown answer must read as one plain line, not show its syntax.
  test('a markdown answer reads as one plain line', () => {
    expect(plainDetail('- Fixed `reconnect` in [the host](https://x.dev)\n- added a test')).toBe(
      'Fixed reconnect in the host added a test',
    )
  })
})

describe('the group header', () => {
  // WHY: a reader looks first for what still runs, then for outcomes; a state
  // no agent is in prints no zero.
  test('the status line counts working agents first, then outcomes', () => {
    expect(subagentStatusLine(['done', 'running', 'failed', 'running'])).toBe('2 working · 1 done · 1 failed')
    expect(subagentStatusLine(['done', 'done'])).toBe('2 done')
  })
})
