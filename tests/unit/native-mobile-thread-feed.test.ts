import { describe, expect, test } from 'bun:test'
import { deriveThreadFeedPresentation, LIVE_ACTIVITY_ROW_ID, type FeedSourceEntry, type ThreadFeedRow } from '../../apps/mobile/src/features/threads/thread-feed-presentation'
import { summarizeToolGroup, toolActivitySummary, toolDetailImages, toolFullDetail, toolGroupAction, toolRowLabel } from '../../apps/mobile/src/features/threads/thread-work-log-presentation'

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

const shape = (rows: ThreadFeedRow[]) => rows.filter((row) => row.type !== 'turn-images' && row.type !== 'turn-artifacts').map((row) => row.type === 'message' ? `${row.role}:${row.id}` : row.type === 'work-toggle' ? `work:${row.toolIds.join(',')}${row.live ? ':live' : ''}` : row.type)

describe('native thread feed', () => {
  test('a finished turn folds its work and progress notes behind "Worked", keeping the final answer', () => {
    // As on desktop, the opening note is a step toward the answer, not the answer.
    const rows = present([user('u1'), assistant('a1'), tool('t1'), tool('t2'), assistant('a2'), tool('t3'), assistant('a3')])
    expect(shape(rows)).toEqual(['user:u1', 'run-fold', 'assistant:a3'])
    // The person can open the fold and read every step again.
    const opened = present([user('u1'), assistant('a1'), tool('t1'), tool('t2'), assistant('a2'), tool('t3'), assistant('a3')], { expandedTurnIds: ['turn:u1'] })
    expect(shape(opened)).toEqual(['user:u1', 'run-fold', 'assistant:a1', 'work:t1,t2', 'assistant:a2', 'work:t3', 'assistant:a3'])
    // While the turn runs, nothing folds: the notes are how the person follows the work.
    const running = present([user('u1'), assistant('a1'), tool('t1'), assistant('a2')], { turnActive: true })
    expect(shape(running)).toEqual(['user:u1', 'assistant:a1', 'work:t1', 'assistant:a2'])
  })

  test('a settled turn with only a progress note and an answer folds the note', () => {
    expect(shape(present([user('u1'), assistant('a1'), assistant('a2')]))).toEqual(['user:u1', 'run-fold', 'assistant:a2'])
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

  test('tool calls fold without adding their images to the reply gallery', () => {
    // Raw tool image sources must not be promoted into reply output.
    const rows = present([user('u1'), assistant('a1'), tool('t1'), tool('s1'), tool('t2'), assistant('a2')])
    expect(shape(rows)).toEqual(['user:u1', 'run-fold', 'assistant:a2'])
  })

  test("a turn's screenshots follow its reply, as on desktop", () => {
    // The row keeps all image sources below the reply while the calls stay in
    // the work log. Each source subscribes separately to its own images.
    const rows = present([user('u1'), assistant('a1'), tool('s1'), tool('t1'), tool('s2'), tool('s3'), assistant('a2')], { turnActive: true })
    expect(shape(rows)).toEqual(['user:u1', 'assistant:a1', 'work:s1,t1,s2,s3', 'assistant:a2'])
    expect(rows[4]?.type === 'turn-images' && rows[4].itemIds).toEqual(['a1', 'a2'])
    // A new turn starts a new group.
    const next = present([user('u1'), tool('s1'), user('u2'), tool('s2')])
    expect(next.filter((row) => row.type === 'turn-images').map((row) => row.type === 'turn-images' && row.itemIds)).toEqual([])
  })

  test('a finished turn names its prompts for the chips at its end; a running one shows none', () => {
    // WHY: the two prompts bound what the turn linked, and a live turn is not done linking.
    const rows = present([user('u1'), assistant('a1'), user('u2'), assistant('a2')], { turnActive: true })
    const spans = rows.flatMap((row) => row.type === 'turn-artifacts' ? [[row.promptId, row.nextPromptId, row.imageIds]] : [])
    expect(spans).toEqual([['u1', 'u2', ['a1']]])
    const settled = present([user('u1'), assistant('a1')])
    expect(settled.at(-1)).toMatchObject({ type: 'turn-artifacts', promptId: 'u1', nextPromptId: null })
  })

  test('a turn that failed stays open so its error is read in place', () => {
    const rows = present([user('u1'), tool('t1'), { id: 'n1', kind: 'notice', tone: 'error' }])
    expect(shape(rows)).toEqual(['user:u1', 'work:t1', 'notice'])
  })

  test('an expanded group lists its calls under the toggle, and adjacent work rows join one log', () => {
    const rows = present([user('u1'), tool('t1'), tool('t2')], { turnActive: true, expandedWorkGroupIds: ['work-group:t1'] })
    expect(rows.filter((row) => row.type !== 'turn-images').map((row) => row.type)).toEqual(['message', 'work-toggle', 'work-details'])
    expect(rows[1]?.type === 'work-toggle' && rows[1].continuesWorkLog).toBe(true)
    expect(rows[2]?.type === 'work-details' && rows[2].continuesWorkLog).toBe(false)
  })

  test('only the final prose of a settled turn carries its copy row', () => {
    const rows = present([user('u1'), assistant('a1'), assistant('a2')], { expandedTurnIds: ['turn:u1'] })
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

  // WHY: one batch call links a whole stack. Its row must say how many, not
  // repeat the tool name, and a one-target call stays as it was.
  test('a batch link or unlink call reads as its pull requests', () => {
    const urls = [1, 2, 3, 4, 5, 6].map((number) => `https://github.com/acme/app/pull/${number}`)
    const link = { toolName: 'mcp__solus__link', input: JSON.stringify({ kind: 'pr', target_ids: urls }), status: 'running' as const }
    expect(toolActivitySummary(link)).toBe('Linking 6 pull requests')
    expect(summarizeToolGroup([{ ...link, status: 'completed' }])).toBe('Linked 6 pull requests')
    expect(toolActivitySummary({ toolName: 'unlink', input: '{"kind":"pr","states":["closed","merged"]}', status: 'completed' })).toBe('Unlinked closed and merged pull requests')
    expect(toolActivitySummary({ toolName: 'link', input: JSON.stringify({ kind: 'pr', target_id: urls[0] }), status: 'completed' })).toBe('link')
  })

  test('a row shows the command or file; its detail adds the error', () => {
    expect(toolRowLabel({ toolName: 'exec_command', input: '{"cmd":["bash","-lc","git status --short"]}' })).toBe('git status --short')
    expect(toolRowLabel({ toolName: 'Edit', input: '{"file_path":"/repo/src/app.ts"}' })).toBe('app.ts')
    expect(toolRowLabel({ toolName: 'Edit', input: '{"file_path":"/repo/src/app.ts"}' }, true)).toBe('/repo/src/app.ts')
    expect(toolFullDetail({ input: '{"command":"bun test"}', errorHead: 'exit 1' })).toBe('bun test\n\nexit 1')
    expect(toolFullDetail({ input: null, errorHead: null })).toBeNull()
  })

  test('a Codex patch counts and names every file it changes', () => {
    // WHY: Codex records one Edit call for a whole patch, so counting calls
    // said "Changed 1 file" and the row named nothing.
    const patch = (...paths: string[]) => JSON.stringify({ changes: paths.map((path) => ({ path, kind: { type: 'update' } })) })
    const tool = { toolName: 'Edit', input: patch('/repo/src/a.ts', '/repo/src/b.ts', '/repo/src/c.ts'), status: 'completed' as const }
    expect(summarizeToolGroup([tool])).toBe('Changed 3 files')
    expect(toolRowLabel(tool)).toBe('a.ts and 2 more files')
    expect(toolRowLabel(tool, true)).toBe('/repo/src/a.ts\n/repo/src/b.ts\n/repo/src/c.ts')
    expect(toolActivitySummary(tool)).toBe('Edited a.ts and 2 more files')
    // A second patch on a file already named is not another file; a second call
    // still counts as a call for the rest of the sentence.
    const tools = [tool, { ...tool, input: patch('/repo/src/a.ts', '/repo/src/d.ts') }, { toolName: 'Bash', input: '{"command":"bun test"}', status: 'completed' as const }]
    expect(summarizeToolGroup(tools)).toBe('Changed 4 files and ran 1 command')
    // An edit whose input has not landed still reads as one file.
    expect(summarizeToolGroup([{ toolName: 'Edit', input: null, status: 'completed' }])).toBe('Changed 1 file')
    // A `changes` value that is no file list does not cost the call its label.
    expect(toolRowLabel({ toolName: 'Edit', input: '{"file_path":"/repo/a.ts","changes":"many"}' })).toBe('a.ts')
  })

  test('an open call shows its images only once it has finished', () => {
    const images = [{ assetId: `${'a'.repeat(64)}.png`, mimeType: 'image/png' }]
    expect(toolDetailImages({ status: 'running', images })).toEqual([])
    expect(toolDetailImages({ status: 'completed', images })).toEqual(images)
    expect(toolDetailImages({ status: 'error' })).toEqual([])
  })
})

// Back-to-back prompts on the phone read as one burst, as on desktop: the
// first drops its gap. A reply between them, or a host wake, keeps them apart.
describe('native thread feed bursts', () => {
  const grouped = (rows: ThreadFeedRow[]) =>
    rows.flatMap((row) => row.type === 'message' && row.role === 'user' ? [`${row.id}:${row.groupedWithNext === true}`] : [])

  test('consecutive prompts group; a reply ends the burst', () => {
    expect(grouped(present([user('u1'), user('u2'), user('u3'), assistant('a1'), user('u4')]))).toEqual([
      'u1:true', 'u2:true', 'u3:false', 'u4:false',
    ])
  })

  test('a host wake drawn as a notice row never joins a burst', () => {
    const wake: FeedSourceEntry = { id: 'w1', kind: 'user', hostNotice: true }
    expect(grouped(present([user('u1'), wake, user('u2')]))).toEqual(['u1:false', 'w1:false', 'u2:false'])
  })
})
