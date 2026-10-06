import { describe, expect, test } from 'bun:test'
import { deriveThreadFeedPresentation, LIVE_ACTIVITY_ROW_ID, type FeedSourceEntry, type ThreadFeedRow } from '../../apps/mobile/src/features/threads/thread-feed-presentation'
import { summarizeToolGroup, toolActivitySummary, toolFullDetail, toolGroupAction, toolRowLabel } from '../../apps/mobile/src/features/threads/thread-work-log-presentation'

const user = (id: string): FeedSourceEntry => ({ id, kind: 'user' })
const assistant = (id: string): FeedSourceEntry => ({ id, kind: 'assistant' })
const tool = (id: string): FeedSourceEntry => ({ id, kind: 'tool' })

function present(entries: FeedSourceEntry[], options: { turnActive?: boolean; working?: boolean; expandedTurnIds?: string[]; expandedWorkGroupIds?: string[] } = {}): ThreadFeedRow[] {
  return deriveThreadFeedPresentation({
    entries,
    turnActive: options.turnActive ?? false,
    working: options.working ?? false,
    expandedTurnIds: new Set(options.expandedTurnIds ?? []),
    expandedWorkGroupIds: new Set(options.expandedWorkGroupIds ?? []),
  })
}

const shape = (rows: ThreadFeedRow[]) => rows.map((row) => row.type === 'message' ? `${row.role}:${row.id}` : row.type === 'work-toggle' ? `work:${row.toolIds.join(',')}${row.live ? ':live' : ''}` : row.type)

describe('native thread feed', () => {
  test('a finished turn folds its work behind "Worked", keeping the first and last prose', () => {
    const rows = present([user('u1'), assistant('a1'), tool('t1'), tool('t2'), assistant('a2'), tool('t3'), assistant('a3')])
    expect(shape(rows)).toEqual(['user:u1', 'assistant:a1', 'run-fold', 'assistant:a3'])
    // The person can open the fold and read every step again.
    const opened = present([user('u1'), assistant('a1'), tool('t1'), tool('t2'), assistant('a2'), tool('t3'), assistant('a3')], { expandedTurnIds: ['turn:u1'] })
    expect(shape(opened)).toEqual(['user:u1', 'assistant:a1', 'run-fold', 'work:t1,t2', 'assistant:a2', 'work:t3', 'assistant:a3'])
  })

  test('the running turn never folds, and its trailing tool group is the live slot', () => {
    const rows = present([user('u1'), tool('t1'), tool('t2')], { turnActive: true, working: true })
    expect(shape(rows)).toEqual(['user:u1', 'work:t1,t2:live'])
    expect(rows[1]?.id).toBe(LIVE_ACTIVITY_ROW_ID)
  })

  test('while the agent writes prose, one Thinking slot keeps the place of the next step', () => {
    const rows = present([user('u1'), assistant('a1')], { turnActive: true, working: true })
    expect(shape(rows)).toEqual(['user:u1', 'assistant:a1', 'thinking'])
    // Waiting on the person is not working: no live slot.
    expect(shape(present([user('u1'), assistant('a1')], { turnActive: true, working: false }))).toEqual(['user:u1', 'assistant:a1'])
  })

  test('a turn that failed stays open so its error is read in place', () => {
    const rows = present([user('u1'), tool('t1'), { id: 'n1', kind: 'notice', tone: 'error' }])
    expect(shape(rows)).toEqual(['user:u1', 'work:t1', 'notice'])
  })

  test('an expanded group lists its calls under the toggle, and adjacent work rows join one log', () => {
    const rows = present([user('u1'), tool('t1'), tool('t2')], { turnActive: true, expandedWorkGroupIds: ['work-group:t1'] })
    expect(rows.map((row) => row.type)).toEqual(['message', 'work-toggle', 'work-details'])
    expect(rows[1]?.type === 'work-toggle' && rows[1].continuesWorkLog).toBe(true)
    expect(rows[2]?.type === 'work-details' && rows[2].continuesWorkLog).toBe(false)
  })

  test('only the final prose of a settled turn carries its copy row', () => {
    const rows = present([user('u1'), assistant('a1'), assistant('a2')])
    expect(rows.filter((row) => row.type === 'message' && row.role === 'assistant').map((row) => row.type === 'message' && row.showMeta)).toEqual([false, true])
  })
})

describe('native work log wording', () => {
  test('tool names classify by what the call does across providers', () => {
    expect(toolGroupAction('Read')).toBe('read')
    expect(toolGroupAction('exec_command')).toBe('command')
    expect(toolGroupAction('apply_patch')).toBe('edit')
    expect(toolGroupAction('mcp__solus__browser_open')).toBe('browser')
    expect(toolGroupAction('TodoWrite')).toBe('other')
  })

  test('a group reads as its two weightiest actions and a count of the rest', () => {
    const tools = [
      { toolName: 'Read', input: null, status: 'completed' as const },
      { toolName: 'Read', input: null, status: 'completed' as const },
      { toolName: 'Bash', input: '{"command":"bun test"}', status: 'completed' as const },
      { toolName: 'Grep', input: null, status: 'completed' as const },
    ]
    expect(summarizeToolGroup(tools)).toBe('Read 2 files, ran 1 command, and performed 1 other action')
    expect(summarizeToolGroup(tools.slice(0, 3))).toBe('Read 2 files and ran 1 command')
  })

  test('one call reads as itself, present tense while it runs', () => {
    const running = { toolName: 'Bash', input: '{"command":"FOO=1 bun test --watch"}', status: 'running' as const }
    expect(toolActivitySummary(running)).toBe('Running bun')
    expect(summarizeToolGroup([{ ...running, status: 'completed' }])).toBe('Ran bun')
    expect(toolActivitySummary({ toolName: 'Read', input: '{"file_path":"/repo/src/app.ts"}', status: 'completed' })).toBe('Read app.ts')
  })

  test('a row shows the command or file; its detail adds the error', () => {
    expect(toolRowLabel({ toolName: 'exec_command', input: '{"cmd":["bash","-lc","git status --short"]}' })).toBe('git status --short')
    expect(toolRowLabel({ toolName: 'Edit', input: '{"file_path":"/repo/src/app.ts"}' })).toBe('app.ts')
    expect(toolRowLabel({ toolName: 'Edit', input: '{"file_path":"/repo/src/app.ts"}' }, true)).toBe('/repo/src/app.ts')
    expect(toolFullDetail({ input: '{"command":"bun test"}', errorHead: 'exit 1' })).toBe('bun test\n\nexit 1')
    expect(toolFullDetail({ input: null, errorHead: null })).toBeNull()
  })
})
