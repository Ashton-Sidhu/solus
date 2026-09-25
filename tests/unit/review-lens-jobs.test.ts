import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AgentDispatcher } from '@solus/server/agents/agent-runner'
import type { IpcContext } from '@solus/contracts/types'
import type {
  ReviewLensAddress,
  ReviewLensChangedEvent,
  ReviewLensRecord,
  ReviewTarget,
} from '@solus/contracts/review'
import type { ReviewLensJobDependencies, ResolvedLensChange } from '@solus/server/review/lens-jobs'
import type { LensAgentInput } from '@solus/server/review/lens-agent'
import type { LensDraft } from '@solus/server/review/review-lens-tool'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let ReviewLensJobs: typeof import('@solus/server/review/lens-jobs')['ReviewLensJobs']
beforeAll(async () => {
  ;({ ReviewLensJobs } = await import('@solus/server/review/lens-jobs'))
})

// Rules from docs/plans/review-lenses.md: one lens per target, one previous
// version for Restore, a run replaces the lens only when it succeeds, and lens
// comments follow the version they were written on.

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext
const prTarget: ReviewTarget = { kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 7, baseSha: 'base', headSha: 'head' }
const address: ReviewLensAddress = { repoRoot: 'pr:github.com/acme/app', key: 'pr-7' }

function fixture(overrides: Partial<ReviewLensJobDependencies> = {}) {
  let record: ReviewLensRecord | null = null
  let clock = 1_000
  const events: ReviewLensChangedEvent[] = []
  const agentRuns: { input: LensAgentInput; answer: ReturnType<typeof deferred<LensDraft | null>> }[] = []
  const posts: { body: string }[] = []
  const deletes: string[] = []
  const change = {
    workTree: '/repo',
    headSha: 'head',
    review: { key: 'k', branch: 'b', targetBranch: 'main', baseSha: 'base', headSha: 'head', repoRoot: '/repo' },
    change: {
      guideKey: 'pr-7', scope: 'pr', target: prTarget, base: 'base', head: 'head',
      sessionId: null, patch: 'diff --git a/a.ts b/a.ts\n+x', changeFingerprint: 'fp-1',
    },
  } satisfies ResolvedLensChange
  const deps: Partial<ReviewLensJobDependencies> = {
    locate: async (_ctx, target) => ({ address, target }),
    resolveChange: async () => change,
    isOutdated: async () => false,
    readLedger: async () => null,
    runAgent: (input) => {
      const answer = deferred<LensDraft | null>()
      agentRuns.push({ input, answer })
      return answer.promise
    },
    read: async () => (record ? structuredClone(record) : null),
    write: async (_address, next, canCommit) => {
      if (canCommit && !canCommit()) return false
      record = structuredClone(next)
      return true
    },
    postComment: async (_target, body) => {
      posts.push({ body })
      return { id: 'IC_1', url: 'https://github.com/acme/app/pull/7#issuecomment-1' }
    },
    deleteComment: async (_target, commentId) => { deletes.push(commentId) },
    now: () => ++clock,
    ...overrides,
  }
  const jobs = new ReviewLensJobs({} as AgentDispatcher, deps)
  const emit = (event: ReviewLensChangedEvent) => { events.push(event) }
  return {
    jobs, emit, events, agentRuns, posts, deletes,
    record: () => record,
    setRecord: (next: ReviewLensRecord) => { record = next },
  }
}

/** Let queued microtasks and awaited deps settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function generate(f: ReturnType<typeof fixture>, title: string) {
  await f.jobs.generate(ctx, { target: prTarget, source: { name: title, prompt: `Draw ${title}` } }, f.emit)
  await settle()
  f.agentRuns.at(-1)!.answer.resolve({ title, html: `<p>${title}</p>` })
  await settle()
}

describe('review lens jobs', () => {
  test('a new lens replaces the current one and keeps exactly one previous version', async () => {
    const f = fixture()
    await generate(f, 'First')
    await generate(f, 'Second')
    await generate(f, 'Third')
    expect(f.record()?.current.lens.title).toBe('Third')
    expect(f.record()?.previous?.lens.title).toBe('Second')
    expect(f.events.at(-1)?.job?.status).toBe('ready')
    expect(f.events.at(-1)?.revision).toBe(f.record()!.updatedAt)
  })

  test('restore swaps the two versions and a second restore swaps them back', async () => {
    const f = fixture()
    await generate(f, 'First')
    await generate(f, 'Second')
    const restored = await f.jobs.restore(ctx, prTarget, f.emit)
    expect(restored?.current?.lens.title).toBe('First')
    expect(restored?.hasPrevious).toBe(true)
    const back = await f.jobs.restore(ctx, prTarget, f.emit)
    expect(back?.current?.lens.title).toBe('Second')
  })

  test('restore with no previous version is refused', async () => {
    const f = fixture()
    await generate(f, 'Only')
    await expect(f.jobs.restore(ctx, prTarget, f.emit)).rejects.toThrow('no previous lens')
  })

  test('a failed run keeps the current lens and reports why', async () => {
    const f = fixture()
    await generate(f, 'Kept')
    await f.jobs.generate(ctx, { target: prTarget, source: { name: 'Next', prompt: 'Next' } }, f.emit)
    await settle()
    f.agentRuns.at(-1)!.answer.resolve(null)
    await settle()
    expect(f.record()?.current.lens.title).toBe('Kept')
    expect(f.events.at(-1)?.job).toMatchObject({ status: 'failed', error: expect.stringContaining("didn't return a lens") })
  })

  test('a newer request cancels the running one, and the older result is never saved', async () => {
    const f = fixture()
    await f.jobs.generate(ctx, { target: prTarget, source: { name: 'Old', prompt: 'Old' } }, f.emit)
    await settle()
    await f.jobs.generate(ctx, { target: prTarget, source: { name: 'New', prompt: 'New' } }, f.emit)
    await settle()
    expect(f.agentRuns[0].input.abortSignal.aborted).toBe(true)
    f.agentRuns[0].answer.resolve({ title: 'Old', html: '<p>old</p>' })
    await settle()
    expect(f.record()).toBeNull()
    f.agentRuns[1].answer.resolve({ title: 'New', html: '<p>new</p>' })
    await settle()
    expect(f.record()?.current.lens.title).toBe('New')
    expect(f.record()?.previous).toBeUndefined()
  })

  test('cancel stops the run and reports cancelled', async () => {
    const f = fixture()
    await f.jobs.generate(ctx, { target: prTarget, source: { name: 'A', prompt: 'A' } }, f.emit)
    await settle()
    expect(await f.jobs.cancel(ctx, prTarget, f.emit)).toBe(true)
    expect(f.events.at(-1)?.job?.status).toBe('cancelled')
    f.agentRuns[0].answer.resolve({ title: 'A', html: '<p>a</p>' })
    await settle()
    expect(f.record()).toBeNull()
  })

  test('an edit keeps the comments, resolves the ones it applied, and sends them to the agent', async () => {
    const f = fixture()
    await generate(f, 'Base')
    const added = await f.jobs.changeComments(ctx, prTarget, { kind: 'add', comment: { pin: { x: 0.1, y: 0.2 }, label: '1', body: 'Bigger boxes', quote: 'Box' } }, f.emit)
    const other = await f.jobs.changeComments(ctx, prTarget, { kind: 'add', comment: { pin: { x: 0.5, y: 0.5 }, label: '2', body: 'Later' } }, f.emit)
    const appliedId = added.comments[0].id
    await f.jobs.edit(ctx, { target: prTarget, prompt: 'Use a darker palette', commentIds: [appliedId] }, f.emit)
    await settle()
    const run = f.agentRuns.at(-1)!
    expect(run.input.edit?.html).toBe('<p>Base</p>')
    expect(run.input.edit?.comments.map((comment) => comment.body)).toEqual(['Bigger boxes'])
    expect(run.input.prompt).toBe('Draw Base')
    run.answer.resolve({ title: 'Base v2', html: '<p>v2</p>' })
    await settle()
    const current = f.record()!.current
    expect(current.lens.edits.map((edit) => edit.prompt)).toEqual(['Use a darker palette'])
    expect(current.comments.find((comment) => comment.id === appliedId)?.resolvedAt).toBeNumber()
    expect(current.comments.find((comment) => comment.id === other.comments[1].id)?.resolvedAt).toBeUndefined()
    expect(f.record()!.previous?.lens.html).toBe('<p>Base</p>')
  })

  test('a comment written while an edit runs survives the commit', async () => {
    const f = fixture()
    await generate(f, 'Base')
    await f.jobs.edit(ctx, { target: prTarget, prompt: 'Tighter', commentIds: [] }, f.emit)
    await settle()
    await f.jobs.changeComments(ctx, prTarget, { kind: 'add', comment: { pin: { x: 0, y: 0 }, label: '1', body: 'Mid-run note' } }, f.emit)
    f.agentRuns.at(-1)!.answer.resolve({ title: 'Base', html: '<p>tighter</p>' })
    await settle()
    expect(f.record()!.current.comments.map((comment) => comment.body)).toEqual(['Mid-run note'])
  })

  test('a new lens starts with no comments; restore brings the old comments back', async () => {
    const f = fixture()
    await generate(f, 'First')
    await f.jobs.changeComments(ctx, prTarget, { kind: 'add', comment: { pin: { x: 0, y: 0 }, label: '1', body: 'On first' } }, f.emit)
    await generate(f, 'Second')
    expect(f.record()!.current.comments).toEqual([])
    const restored = await f.jobs.restore(ctx, prTarget, f.emit)
    expect(restored?.current?.comments.map((comment) => comment.body)).toEqual(['On first'])
  })

  test('an edit with no lens is refused before the running job is touched', async () => {
    const f = fixture()
    await f.jobs.generate(ctx, { target: prTarget, source: { name: 'A', prompt: 'A' } }, f.emit)
    await settle()
    await expect(f.jobs.edit(ctx, { target: prTarget, prompt: 'x', commentIds: [] }, f.emit)).rejects.toThrow('no lens to edit')
    expect(f.agentRuns[0].input.abortSignal.aborted).toBe(false)
  })

  test('posting quotes the pinned text, records the link, and retract takes it back', async () => {
    const f = fixture()
    await generate(f, 'Risk map')
    const { comments } = await f.jobs.changeComments(ctx, prTarget, { kind: 'add', comment: { pin: { x: 0, y: 0 }, label: '1', body: 'Is this safe?', quote: 'auth.ts: token refresh' } }, f.emit)
    const commentId = comments[0].id
    const posted = await f.jobs.postComment(ctx, prTarget, commentId, f.emit)
    expect(f.posts[0].body).toContain('> auth.ts: token refresh')
    expect(f.posts[0].body).toContain('Is this safe?')
    expect(f.posts[0].body).toContain('Risk map')
    expect(posted.comments[0].posted).toEqual({ kind: 'conversation', commentId: 'IC_1', url: 'https://github.com/acme/app/pull/7#issuecomment-1' })
    await expect(f.jobs.postComment(ctx, prTarget, commentId, f.emit)).rejects.toThrow('already on the pull request')
    await expect(f.jobs.changeComments(ctx, prTarget, { kind: 'delete', commentId }, f.emit)).rejects.toThrow('Retract')
    const retracted = await f.jobs.retractComment(ctx, prTarget, commentId, f.emit)
    expect(f.deletes).toEqual(['IC_1'])
    expect(retracted.comments[0].posted).toBeUndefined()
    const deleted = await f.jobs.changeComments(ctx, prTarget, { kind: 'delete', commentId }, f.emit)
    expect(deleted.comments).toEqual([])
  })

  test('only a pull-request lens can post', async () => {
    const f = fixture()
    await expect(f.jobs.postComment(ctx, { kind: 'working-tree' }, 'c', f.emit)).rejects.toThrow('pull-request lens')
  })

  test('a draft line comment is marked and unmarked without reaching the code host', async () => {
    const f = fixture()
    await generate(f, 'Map')
    const { comments } = await f.jobs.changeComments(ctx, prTarget, { kind: 'add', comment: { pin: { x: 0, y: 0 }, label: '1', body: 'Rename', codeAnchor: { path: 'a.ts', line: 3 } } }, f.emit)
    const drafted = await f.jobs.changeComments(ctx, prTarget, { kind: 'mark-drafted', commentId: comments[0].id, draftId: 'd1' }, f.emit)
    expect(drafted.comments[0].posted).toEqual({ kind: 'draft-line', draftId: 'd1' })
    const undrafted = await f.jobs.changeComments(ctx, prTarget, { kind: 'mark-drafted', commentId: comments[0].id, draftId: null }, f.emit)
    expect(undrafted.comments[0].posted).toBeUndefined()
    expect(f.posts).toEqual([])
  })

  test('the submit tool refuses HTML over the size limit, so an oversized lens never reaches clients', async () => {
    const { parseLensArgs } = await import('@solus/server/review/review-lens-tool')
    const { REVIEW_LENS_MAX_HTML_CHARS } = await import('@solus/contracts/review')
    expect(parseLensArgs({ title: 'Big', html: 'x'.repeat(REVIEW_LENS_MAX_HTML_CHARS + 1) }).ok).toBe(false)
    expect(parseLensArgs({ title: '', html: '   ' }).ok).toBe(false)
    expect(parseLensArgs({ title: '', html: '<p>ok</p>' })).toEqual({ ok: true, lens: { title: 'Lens', html: '<p>ok</p>' } })
  })

  test('a lens edit prompt carries the current HTML and the comment anchors', async () => {
    const { buildLensPrompt } = await import('@solus/server/review/lens-agent')
    const prompt = buildLensPrompt({
      workTree: '/repo', base: 'b', head: 'h', inlineDiff: '+x', ledger: null, prompt: 'Show risk',
      edit: { html: '<main>now</main>', prompt: 'Add a legend', comments: [{ label: '1', body: 'Too small', codeAnchor: { path: 'a.ts', line: 4 } }] },
      agent: 'claude-code', model: null, reasoningEffort: null,
    })
    expect(prompt).toContain('<main>now</main>')
    expect(prompt).toContain('Add a legend')
    expect(prompt).toContain('(a.ts:4)')
    expect(prompt).toContain('NO network access')
    expect(prompt).toContain('data-solus-file')
  })
})
