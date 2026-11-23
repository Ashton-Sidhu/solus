import { describe, expect, test } from 'bun:test'
import {
  subagentDetail,
  subagentTargetPath,
} from '@solus/workspace-ui/components/conversation/lib/subagent-card'
import {
  plainDetail,
  subagentDotMark,
  subagentLinkStatus,
  subagentStatusLine,
} from '@solus/workspace-ui/components/conversation/lib/agent-link'
import type { Message } from '@solus/contracts/types'

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

  // WHY: the mark and the word must agree, and a running agent's mark is
  // the one its step has, the same mark the sidebar gives that activity.
  test('each state has one standing, one mark, and one word', () => {
    expect(subagentLinkStatus({ state: 'running', liveMark: 'reading' })).toEqual({
      standing: 'live',
      mark: { kind: 'dot', mark: 'reading' },
      label: 'Running',
    })
    expect(subagentLinkStatus({ state: 'running', liveMark: null }).mark).toEqual({ kind: 'dot', mark: 'working' })
    expect(subagentLinkStatus({ state: 'done', liveMark: null })).toEqual({
      standing: 'done',
      mark: { kind: 'glyph', status: 'finished' },
      label: 'Completed',
    })
    expect(subagentLinkStatus({ state: 'failed', liveMark: null })).toEqual({
      standing: 'failed',
      mark: { kind: 'glyph', status: 'error' },
      label: 'Failed',
    })
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

describe("a running sub-agent's dot mark", () => {
  const agent = (overrides: Partial<Message>): Message =>
    ({ id: 'a', role: 'tool', content: '', toolName: 'Agent', toolStatus: 'running', timestamp: 0, ...overrides }) as Message
  const tool = (toolName: string, toolStatus: Message['toolStatus'] = 'running'): Message =>
    ({ id: toolName, role: 'tool', content: '', toolName, toolStatus, timestamp: 0 }) as Message

  // WHY: the row says what the agent does this second, in the mark the
  // sidebar gives the same activity, for each kind of tool.
  test('the tool in flight gives the mark of its activity', () => {
    const markFor = (toolName: string) => subagentDotMark(agent({ subMessages: [tool(toolName)] }))
    expect(markFor('Read')).toBe('reading')
    expect(markFor('Grep')).toBe('searching')
    expect(markFor('Edit')).toBe('editing')
    expect(markFor('Bash')).toBe('running')
    expect(markFor('exec_command')).toBe('running')
    expect(markFor('mcp__solus__link')).toBe('working')
  })

  // WHY: streamed text is the agent writing; a step that settled is the agent
  // thinking about the next one, since the host drops a sub-agent's thinking.
  test('streamed text writes, and a settled step thinks', () => {
    const streaming = { id: 't', role: 'assistant', content: 'So', isStreaming: true, timestamp: 0 } as Message
    const said = { id: 't', role: 'assistant', content: 'So.', timestamp: 0 } as Message
    expect(subagentDotMark(agent({ subMessages: [tool('Read', 'completed'), streaming] }))).toBe('writing')
    expect(subagentDotMark(agent({ subMessages: [tool('Read', 'completed')] }))).toBe('thinking')
    expect(subagentDotMark(agent({ subMessages: [said] }))).toBe('thinking')
  })

  // WHY: only the last row counts. An older tool that still says running must
  // not outvote the step the agent is on now.
  test('only the last row of the nested transcript counts', () => {
    const streaming = { id: 't', role: 'assistant', content: 'So', isStreaming: true, timestamp: 0 } as Message
    expect(subagentDotMark(agent({ subMessages: [tool('Read'), streaming] }))).toBe('writing')
  })

  // WHY: a backgrounded agent with no nested transcript still names its last
  // tool in its heartbeat; with nothing known the row only says it works.
  test('with no nested transcript the heartbeat names the step, else Working', () => {
    expect(subagentDotMark(agent({ subMessages: [], backgroundTaskProgress: { lastToolName: 'Glob' } }))).toBe('searching')
    expect(subagentDotMark(agent({ backgroundTaskProgress: { lastToolName: 'Write' } }))).toBe('editing')
    expect(subagentDotMark(agent({ subMessages: [] }))).toBe('working')
  })
})
