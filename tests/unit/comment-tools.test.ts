import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PlanAnnotations, SessionMeta } from '../../src/shared/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type CommentToolsModule = typeof import('../../src/main/annotations/comment-tools')
type SessionToolsModule = typeof import('../../src/main/sessions/session-tools')
type PlanAnnotationsModule = typeof import('../../src/main/plans/annotations')
type WorkAnnotationsModule = typeof import('../../src/main/folio/work-annotations')
type WorksModule = typeof import('../../src/main/folio/works')
let commentTools: CommentToolsModule
let sessionTools: SessionToolsModule
let planAnnotations: PlanAnnotationsModule
let workAnnotations: WorkAnnotationsModule
let works: WorksModule
let closeDb: () => void

const CWD = '/Users/test/proj'
const PLAN_ID = 'peer-1__toolu_1'
const PLAN_TEXT = [
  '# Evict on write',
  '',
  'The **sweep** holds the lock for the whole scan.',
  '',
  '- Swap under a read lock',
  '- Measure p99 before and after',
].join('\n')

const PEER: SessionMeta = {
  provider: 'claude-code',
  sessionId: 'peer-1',
  slug: 'peer',
  firstMessage: null,
  lastTimestamp: '',
  size: 0,
  cwd: CWD,
  projectPath: CWD,
}

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-comments-'))
  process.env.SOLUS_DATA_DIR = dataDir
  commentTools = await import('../../src/main/annotations/comment-tools')
  sessionTools = await import('../../src/main/sessions/session-tools')
  planAnnotations = await import('../../src/main/plans/annotations')
  workAnnotations = await import('../../src/main/folio/work-annotations')
  works = await import('../../src/main/folio/works')
  ;({ closeDb } = await import('../../src/main/db'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

function installController(): void {
  sessionTools.setSessionController({
    listSessions: async () => [],
    getSessionInfo: async (sessionId) => (sessionId === PEER.sessionId ? PEER : { ...PEER, sessionId, slug: 'caller' }),
    loadSessionTail: async () => [],
    liveStatus: () => null,
    pendingInputEvents: () => [],
    promptSession: async () => ({ disposition: 'queued' as const }),
    watchSessionSettled: () => {},
    stopSession: () => true,
    answerQuestion: () => true,
    respondPermission: () => true,
    loadPlanContent: async () => PLAN_TEXT,
    listPlans: async () => [
      { planToolUseId: 'toolu_0', sessionId: 'peer-1', projectPath: CWD, cwd: CWD, timestamp: 1, title: 'old', excerpt: '', status: 'pending' as const, commentCount: 0, bookmarked: false, revisions: [] },
      { planToolUseId: 'toolu_1', sessionId: 'peer-1', projectPath: CWD, cwd: CWD, timestamp: 2, title: 'Evict on write', excerpt: '', status: 'pending' as const, commentCount: 0, bookmarked: false, revisions: [] },
    ],
    invalidatePlanCaches: () => {},
  })
}

async function seedPlan(): Promise<void> {
  const annotations: PlanAnnotations = {
    version: 1,
    sessionId: 'peer-1',
    projectPath: CWD,
    cwd: CWD,
    planToolUseId: 'toolu_1',
    title: 'Evict on write',
    status: 'pending',
    comments: [],
    bookmarked: false,
    updatedAt: Date.now(),
  }
  await planAnnotations.saveAnnotations(annotations)
}

function run(name: string, args: Parameters<CommentToolsModule['executeCommentTool']>[1]) {
  return commentTools.executeCommentTool(name, args, {
    ctx: { agentProvider: 'codex', cwd: CWD, sessionId: 'caller-1' },
  })
}

beforeEach(async () => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  installController()
  await seedPlan()
})

describe('anchoring', () => {
  test('a quote in the rendered text anchors at its offset in that projection', async () => {
    // WHY: the editor searches `doc.textBetween(...)` — the RENDERED text — so
    // the offset has to index the same projection, not the markdown source.
    const result = await run('comment_document', {
      target_id: PLAN_ID,
      comments: [{ quote: 'sweep holds the lock', comment: 'only during the swap, surely?' }],
    })
    expect(result.ok).toBe(true)
    const saved = await planAnnotations.loadAnnotations('peer-1', 'toolu_1')
    const comment = saved!.comments[0]
    expect(comment.selectedText).toBe('sweep holds the lock')
    expect(commentTools.renderedText(PLAN_TEXT).slice(comment.textOffset!)).toStartWith('sweep holds the lock')
  })

  test('a quote carrying markdown syntax is refused rather than written unanchored', async () => {
    // WHY: `**sweep**` is not in the rendered text and can NEVER anchor. Writing
    // it anyway produces a thread with no highlight and no way to find it.
    const result = await run('comment_document', {
      target_id: PLAN_ID,
      comments: [{ quote: 'The **sweep** holds the lock', comment: 'x' }],
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('RENDERED text')
    expect((await planAnnotations.loadAnnotations('peer-1', 'toolu_1'))!.comments).toHaveLength(0)
  })

  test('an ambiguous quote is refused — it would anchor to the wrong place', async () => {
    const result = await run('comment_document', {
      target_id: PLAN_ID,
      comments: [{ quote: 'lock', comment: 'which one?' }],
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('more than once')
    expect((await planAnnotations.loadAnnotations('peer-1', 'toolu_1'))!.comments).toHaveLength(0)
  })

  test('one bad quote in a batch writes none of them', async () => {
    // WHY: a partial review is worse than a refused one — the agent has no way
    // to tell which of its notes landed.
    const result = await run('comment_document', {
      target_id: PLAN_ID,
      comments: [
        { quote: 'Measure p99 before and after', comment: 'good' },
        { quote: 'nowhere in the plan', comment: 'bad' },
      ],
    })
    expect(result.ok).toBe(false)
    expect((await planAnnotations.loadAnnotations('peer-1', 'toolu_1'))!.comments).toHaveLength(0)
  })
})

describe('authorship', () => {
  test('authorAgent survives save/load, so the rail can say which agent wrote it', async () => {
    await run('comment_document', {
      target_id: PLAN_ID,
      comments: [{ quote: 'Swap under a read lock', comment: 'and the writers?' }],
    })
    const saved = await planAnnotations.loadAnnotations('peer-1', 'toolu_1')
    expect(saved!.comments[0]).toMatchObject({
      author: 'solus',
      authorAgent: { sessionId: 'caller-1', title: 'caller', provider: 'codex' },
    })
  })
})

describe('replies and resolution round-trip through both stores', () => {
  test('a plan thread takes a reply and then resolves', async () => {
    await run('comment_document', { target_id: PLAN_ID, comments: [{ quote: 'Swap under a read lock', comment: 'and the writers?' }] })
    const commentId = (await planAnnotations.loadAnnotations('peer-1', 'toolu_1'))!.comments[0].id

    expect((await run('reply_comment', { target_id: PLAN_ID, comment_id: commentId, text: 'writers take the write lock' })).ok).toBe(true)
    const replied = await planAnnotations.loadAnnotations('peer-1', 'toolu_1')
    expect(replied!.comments[0].replies).toMatchObject([{ author: 'solus', text: 'writers take the write lock' }])

    expect((await run('resolve_comment', { target_id: PLAN_ID, comment_id: commentId })).ok).toBe(true)
    const resolvedThread = (await planAnnotations.loadAnnotations('peer-1', 'toolu_1'))!.comments[0]
    expect(typeof resolvedThread.resolvedAt).toBe('number')
    expect(resolvedThread.resolvedBy).toBe('solus')
  })

  test('a work thread takes a reply and then resolves', async () => {
    const work = await works.createWork('Spec', 'doc', 'The eviction pass runs on write.', '', 'peer-1', 'claude-code', CWD)
    expect((await run('comment_document', { target_id: work.id, comments: [{ quote: 'eviction pass runs on write', comment: 'on read too' }] })).ok).toBe(true)
    const commentId = (await workAnnotations.loadWorkAnnotations(work.id))!.comments[0].id

    await run('reply_comment', { target_id: work.id, comment_id: commentId, text: 'read path is separate' })
    await run('resolve_comment', { target_id: work.id, comment_id: commentId })
    const thread = (await workAnnotations.loadWorkAnnotations(work.id))!.comments[0]
    expect(thread.replies).toHaveLength(1)
    expect(typeof thread.resolvedAt).toBe('number')
  })

  test('a plan nobody has annotated yet takes its first thread, creating the row', async () => {
    // WHY: reading a plan does not create an annotations row, so requiring one
    // would make commenting fail on exactly the plans an agent reviews.
    await planAnnotations.saveAnnotations({
      version: 1, sessionId: 'other', projectPath: CWD, cwd: CWD, planToolUseId: 'x',
      title: 't', status: 'pending', comments: [], bookmarked: false, updatedAt: Date.now(),
    })
    const result = await run('comment_document', {
      target_id: 'peer-1__toolu_fresh',
      comments: [{ quote: 'Swap under a read lock', comment: 'and the writers?' }],
    })
    expect(result.ok).toBe(true)
    const saved = await planAnnotations.loadAnnotations('peer-1', 'toolu_fresh')
    expect(saved).toMatchObject({ title: 'Evict on write', status: 'pending', cwd: CWD })
    expect(saved!.comments).toHaveLength(1)
  })

  test('an unknown target and an unknown thread are both refused by name', async () => {
    expect((await run('comment_document', { target_id: 'nope', comments: [{ quote: 'a', comment: 'b' }] })).ok).toBe(false)
    expect((await run('reply_comment', { target_id: PLAN_ID, comment_id: 'missing', text: 'x' })).ok).toBe(false)
  })
})

describe('read_plan', () => {
  test("omitting plan_tool_use_id resolves the session's latest plan and serves its open threads", async () => {
    await run('comment_document', { target_id: PLAN_ID, comments: [{ quote: 'Measure p99 before and after', comment: 'against which baseline?' }] })
    const result = await run('read_plan', { session_id: 'peer-1' })
    expect(result.ok).toBe(true)
    expect(result.text).toContain(`id: ${PLAN_ID}`)
    expect(result.text).toContain('holds the lock for the whole scan')
    expect(result.text).toContain('against which baseline?')
  })

  test('a resolved thread stops being served back', async () => {
    // WHY: re-serving a settled thread reads as a fresh request and the agent
    // does the work twice.
    await run('comment_document', { target_id: PLAN_ID, comments: [{ quote: 'Measure p99 before and after', comment: 'against which baseline?' }] })
    const commentId = (await planAnnotations.loadAnnotations('peer-1', 'toolu_1'))!.comments[0].id
    await run('resolve_comment', { target_id: PLAN_ID, comment_id: commentId })
    const result = await run('read_plan', { session_id: 'peer-1' })
    expect(result.text).not.toContain('against which baseline?')
  })
})
