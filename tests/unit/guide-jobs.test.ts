import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuide, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { GuideJobRequest, GuideRevision, GuideSource } from '@solus/server/review/guide-jobs'
import type { ResolvedPrGuideTarget } from '@solus/server/review/pr-guide-context'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let ReviewGuideJobs: typeof import('@solus/server/review/guide-jobs')['ReviewGuideJobs']
let prGuideKey: typeof import('@solus/server/review/pr-guide-store')['prGuideKey']
let prGuideRepository: typeof import('@solus/server/review/pr-guide-store')['prGuideRepository']
beforeAll(async () => {
  ;({ ReviewGuideJobs } = await import('@solus/server/review/guide-jobs'))
  ;({ prGuideKey, prGuideRepository } = await import('@solus/server/review/pr-guide-store'))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const target: ResolvedPrGuideTarget = {
  kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 42,
  headSha: 'head-a', baseSha: 'base-a',
}
const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext

function guide(title = 'Saved guide'): ReviewGuide {
  return {
    version: 1, key: prGuideKey(target), target, headSha: target.headSha, baseSha: target.baseSha,
    title, summary: 'Reviewed change', sections: [], generatedAt: '2026-09-09T00:00:00Z',
  }
}

/** A source shaped like the pull request one: no I/O, a live revision the test moves. */
function fixture(overrides: Partial<GuideSource> = {}) {
  let saved: ReviewGuide | null = null
  let current: GuideRevision = { headSha: target.headSha, baseSha: target.baseSha }
  const events: ReviewGuideStatusEvent[] = []
  const source: GuideSource = {
    serial: true,
    identify: async (_context, opts) => {
      if (opts.target?.kind !== 'pr') return null
      const key = prGuideKey(opts.target)
      return { jobKey: key, identity: { repoRoot: '/repo', key, scope: 'pr', target: opts.target, headSha: opts.target.headSha ?? '', baseSha: opts.target.baseSha } }
    },
    read: async () => saved,
    live: async () => current,
    author: async (run) => {
      run.reading(current)
      run.progress('analyzing')
      const authored = { ...guide(), ...current }
      return { key: authored.key, guide: authored, persisted: false, authored: true }
    },
    write: async (_identity, value, canCommit) => {
      if (!canCommit()) return false
      saved = value
      return true
    },
    ...overrides,
  }
  const jobs = new ReviewGuideJobs((event) => events.push(event), { pr: source, local: source })
  const request: GuideJobRequest = { ctx, dispatcher: {} as AgentDispatcher, opts: { target } }
  const start = async (overrides: Partial<GuideJobRequest> = {}) => {
    const run = await jobs.request({ ...request, ...overrides })
    if (!run) throw new Error('the fixture names a guide for every pull request')
    return run
  }
  return {
    jobs, source, request, events, start,
    setSaved: (value: ReviewGuide | null) => { saved = value },
    getSaved: () => saved,
    setCurrent: (value: GuideRevision) => { current = value },
  }
}

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('one job per guide', () => {
  test('queued state is readable and published before the run prepares', async () => {
    const preparing = deferred<void>()
    const started = deferred<void>()
    const f = fixture()
    f.source.author = async (run) => {
      started.resolve()
      await preparing.promise
      run.reading(target)
      return { key: guide().key, guide: guide(), persisted: false, authored: true }
    }
    const run = await f.start()
    expect(run.status.status).toBe('queued')
    expect(f.events[0]?.status).toBe('queued')
    expect((await f.jobs.status(ctx, { target }))?.generationId).toBe(run.status.generationId)
    await started.promise
    const anotherClient = { session: { projectPath: '/other-project' } } as IpcContext
    expect((await f.jobs.status(anotherClient, { target }))?.status).toBe('generating')
    preparing.resolve()
    expect((await run.completion)?.persisted).toBe(true)
    expect(f.events.at(-1)?.status).toBe('ready')
  })

  test('cancel during preparation stops the model and preserves the old guide', async () => {
    const preparing = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture()
    f.source.author = async (run) => {
      started.resolve()
      await preparing.promise
      if (run.signal.aborted) return null
      authors++
      return null
    }
    f.setSaved(guide('Old guide'))
    const run = await f.start()
    await started.promise
    expect(await f.jobs.cancel(ctx, { target })).toBe(true)
    expect((await f.jobs.status(ctx, { target }))?.status).toBe('cancelled')
    preparing.resolve()
    expect(await run.completion).toBeNull()
    expect(authors).toBe(0)
    expect(f.getSaved()?.title).toBe('Old guide')
  })

  test('a second request for the same revision joins the running job', async () => {
    const authored = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture()
    f.source.author = async () => {
      authors++
      started.resolve()
      await authored.promise
      return { key: guide().key, guide: guide('Shared'), authored: true, persisted: false }
    }
    const first = await f.start()
    await started.promise
    // WHY: two clients asking for one guide must not pay for two model runs,
    // and the second requester still hears how the run ends.
    const heard: string[] = []
    const second = await f.start({ ctx: { session: { projectPath: '/another-checkout' } } as IpcContext, onStatus: (event) => heard.push(event.status) })
    expect(second.status.generationId).toBe(first.status.generationId)
    authored.resolve()
    expect((await second.completion)?.persisted).toBe(true)
    expect(authors).toBe(1)
    expect(heard.at(-1)).toBe('ready')
  })

  test('a request for another revision replaces the running job and only the replacement writes', async () => {
    const authored = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture()
    f.source.author = async (run) => {
      const sequence = ++authors
      run.reading(sequence === 1 ? target : { headSha: 'head-b' })
      if (sequence === 1) { started.resolve(); await authored.promise; expect(run.signal.aborted).toBe(true) }
      return { key: guide().key, guide: guide(`Guide ${sequence}`), authored: true, persisted: false }
    }
    const first = await f.start()
    await started.promise
    f.setCurrent({ headSha: 'head-b', baseSha: target.baseSha })
    const second = await f.start({ opts: { target: { ...target, headSha: 'head-b' } } })
    expect(second.status.generationId).not.toBe(first.status.generationId)
    expect(f.events.some((event) => event.generationId === first.status.generationId && event.status === 'cancelled')).toBe(true)
    authored.resolve()
    expect(await first.completion).toBeNull()
    expect((await second.completion)?.persisted).toBe(true)
    expect(f.getSaved()?.title).toBe('Guide 2')
  })

  test('a queued request can be cancelled while another guide runs', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture({ author: async () => { authors++; started.resolve(); await gate.promise; return null } })
    const first = await f.start()
    await started.promise
    const other = { ...target, number: 43 }
    const second = await f.start({ opts: { target: other } })
    expect((await f.jobs.status(ctx, { target: other }))?.status).toBe('queued')
    expect(await f.jobs.cancel(ctx, { target: other })).toBe(true)
    gate.resolve()
    await first.completion
    await second.completion
    expect(authors).toBe(1)
  })

  test('model failure and save failure are failed, with the last saved guide intact', async () => {
    for (const failure of ['author', 'write']) {
      const f = fixture(failure === 'author' ? { author: async () => null } : { write: async () => false })
      f.setSaved(guide('Keep me'))
      await (await f.start()).completion
      expect(f.events.at(-1)?.status).toBe('failed')
      expect(f.getSaved()?.title).toBe('Keep me')
    }
  })

  test('a fallback guide is shown as a failure and never saved', async () => {
    const f = fixture({ author: async () => ({ key: guide().key, guide: guide('No changes to review'), persisted: false }) })
    const generated = await (await f.start()).completion
    expect(generated?.guide.title).toBe('No changes to review')
    expect(f.events.at(-1)).toMatchObject({ status: 'failed', error: 'Reviewed change' })
    expect(f.getSaved()).toBeNull()
  })

  test('a revision change during generation keeps the guide and marks it outdated', async () => {
    const f = fixture()
    f.setSaved(guide('Old guide'))
    f.source.author = async (run) => {
      run.reading(target)
      f.setCurrent({ headSha: target.headSha, baseSha: 'base-b' })
      return { key: prGuideKey(target), guide: guide('Kept guide'), authored: true, persisted: false }
    }
    const result = await (await f.start()).completion
    // WHY: the run cost a model call, and its guide still explains the
    // revision it read. The reader sees it as outdated, as after any push.
    expect(result).toMatchObject({ outdated: true, persisted: true })
    expect(f.getSaved()).toMatchObject({ title: 'Kept guide', headSha: 'head-a', baseSha: 'base-a' })
    expect(f.events.at(-1)).toMatchObject({
      status: 'outdated', headSha: 'head-a', baseSha: 'base-b', generatedAt: guide().generatedAt,
    })
  })

  test('an outdated run never replaces a saved guide for the live revision', async () => {
    const f = fixture()
    f.setSaved({ ...guide('Live guide'), baseSha: 'base-b' })
    f.source.author = async (run) => {
      run.reading(target)
      f.setCurrent({ headSha: target.headSha, baseSha: 'base-b' })
      return { key: prGuideKey(target), guide: guide('Older guide'), authored: true, persisted: false }
    }
    const result = await (await f.start()).completion
    expect(result?.guide.title).toBe('Live guide')
    expect(f.getSaved()?.title).toBe('Live guide')
    expect(f.events.at(-1)?.status).toBe('ready')
  })

  test('fresh clients compare the live revision to the saved guide', async () => {
    const f = fixture()
    f.setSaved(guide())
    expect((await f.jobs.status(ctx, { target }))?.status).toBe('ready')
    f.setCurrent({ headSha: target.headSha, baseSha: 'retargeted-base' })
    expect(await f.jobs.status(ctx, { target })).toMatchObject({
      status: 'outdated', headSha: 'head-a', baseSha: 'retargeted-base', generatedAt: guide().generatedAt,
    })
    const restarted = new ReviewGuideJobs(() => {}, { pr: f.source, local: f.source })
    expect((await restarted.status(ctx, { target }))?.status).toBe('outdated')
  })

  test('a fingerprint decides a working-tree change even when the head did not move', async () => {
    const f = fixture()
    f.setSaved({ ...guide(), changeFingerprint: 'patch-a' })
    f.setCurrent({ headSha: target.headSha, baseSha: target.baseSha, changeFingerprint: 'patch-a' })
    expect((await f.jobs.status(ctx, { target }))?.status).toBe('ready')
    f.setCurrent({ headSha: target.headSha, baseSha: target.baseSha, changeFingerprint: 'patch-b' })
    expect((await f.jobs.status(ctx, { target }))?.status).toBe('outdated')
  })

  test('an old status probe cannot hide a generation that starts while it waits', async () => {
    const probe = deferred<ReviewGuide | null>()
    const runGate = deferred<void>()
    const f = fixture({ read: async () => probe.promise })
    f.source.author = async () => {
      await runGate.promise
      return null
    }
    const oldProbe = f.jobs.status(ctx, { target })
    const run = await f.start()
    probe.resolve(guide())
    expect((await oldProbe)?.generationId).toBe(run.status.generationId)
    runGate.resolve()
    await run.completion
  })

  test('a listed status answers from host storage and never asks for the live revision', async () => {
    // A list probes every row at once. Asking the code host for each row's
    // revision is what made one page cost about a hundred GitHub requests.
    const f = fixture({ live: async () => { throw new Error('a listed probe must not check the code host') } })
    expect(await f.jobs.savedStatus(ctx, { target })).toBeNull()

    // A saved guide reports the revision it was written for; the list marks it
    // outdated when that head is not the head it listed.
    f.setSaved(guide())
    expect(await f.jobs.savedStatus(ctx, { target: { ...target, headSha: 'pushed' } })).toMatchObject({
      status: 'ready', headSha: 'head-a', baseSha: 'base-a', generatedAt: guide().generatedAt,
    })
  })

  test('a listed status still reports a generation that is running', async () => {
    const runGate = deferred<void>()
    const f = fixture()
    f.source.author = async () => {
      await runGate.promise
      return null
    }
    const run = await f.start()
    expect((await f.jobs.savedStatus(ctx, { target }))?.generationId).toBe(run.status.generationId)
    runGate.resolve()
    await run.completion
  })

  test('identity ignores checkout, base revision, and repository letter case', () => {
    expect(prGuideRepository(target)).toBe(prGuideRepository({ ...target, host: 'GitHub.com', owner: 'ACME' }))
    expect(prGuideKey(target)).toBe(prGuideKey({ ...target, baseSha: 'another-base', headSha: 'another-head' }))
    expect(prGuideKey(target)).toBe(prGuideKey({ ...target, owner: 'ACME' }))
    expect(prGuideKey({ ...target, owner: 'a-b', repo: 'c' })).not.toBe(prGuideKey({ ...target, owner: 'a', repo: 'b-c' }))
    expect(prGuideKey({ ...target, owner: 'a_2Db' })).not.toBe(prGuideKey({ ...target, owner: 'a-b' }))
  })
})

describe('PR guide content and storage', () => {
  test('one canonical file survives checkout changes and rejects a superseded atomic save', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solus-pr-guide-store-'))
    const previous = process.env.SOLUS_DATA_DIR
    process.env.SOLUS_DATA_DIR = directory
    try {
      const { readPrGuide, writePrGuide, prGuidePath } = await import('@solus/server/review/pr-guide-store')
      expect(await writePrGuide(guide('First'), target, () => true)).toBe(true)
      expect(await writePrGuide(guide('Superseded'), target, () => false)).toBe(false)
      expect((await readPrGuide(target))?.title).toBe('First')
      expect(await writePrGuide(guide('Replacement'), { ...target, headSha: 'head-b' }, () => true)).toBe(true)
      expect((await readPrGuide(target))?.title).toBe('Replacement')
      expect(readdirSync(dirname(prGuidePath(target)))).toEqual([`${prGuideKey(target)}.json`])
    } finally {
      if (previous === undefined) delete process.env.SOLUS_DATA_DIR
      else process.env.SOLUS_DATA_DIR = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each(['claude-code', 'codex'] as const)('%s reviews only exact PR commits and leaves persistence to the job owner', async (agent) => {
    const directory = mkdtempSync(join(tmpdir(), 'solus-pr-guide-patch-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
    try {
      git(['init', '--initial-branch=main'])
      git(['config', 'user.name', 'Test'])
      git(['config', 'user.email', 'test@example.com'])
      writeFileSync(join(directory, 'change.txt'), 'base\n')
      git(['add', '.'])
      git(['commit', '-m', 'base'])
      const baseSha = git(['rev-parse', 'HEAD'])
      git(['update-ref', 'refs/remotes/origin/main', baseSha])
      git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
      git(['checkout', '-b', 'review'])
      writeFileSync(join(directory, 'change.txt'), 'committed PR change\n')
      git(['commit', '-am', 'head'])
      const headSha = git(['rev-parse', 'HEAD'])
      writeFileSync(join(directory, 'change.txt'), 'local edit must not enter guide\n')
      writeFileSync(join(directory, 'untracked.txt'), 'unrelated new file\n')
      let request: AgentRunRequest | null = null
      const dispatcher: AgentDispatcher = {
        runAgent(input) {
          request = input
          const toolContext: AgentToolContext = {
            provider: input.provider, cwd: input.cwd,
            sessionId: () => undefined, abortSignal: new AbortController().signal,
            parentToolUseId: () => undefined, emit: () => {},
          }
          return {
            sessionId: Promise.resolve(null),
            done: input.tools[0].execute({ title: 'PR', summary: 'Change', sections: [] }, toolContext).then(() => ({
              sessionId: null, output: '', toolCallCount: 1, permissionDenials: [], exitCode: 0, signal: null,
            })),
            cancel() {}, handle: {} as AgentRun['handle'],
          }
        },
      }
      const context = { session: { workingDirectory: directory, projectPath: directory }, settings: {} } as IpcContext
      const { authorGuide } = await import('@solus/server/review/guide-producer')
      const authored = await authorGuide(dispatcher, context, {
        agent, target: { ...target, baseSha, headSha },
      }, new AbortController().signal, () => {})
      expect(request?.prompt).toContain('+committed PR change')
      expect(request?.prompt).not.toContain('local edit must not enter guide')
      expect(request?.prompt).not.toContain('untracked.txt')
      expect(authored).toMatchObject({ persisted: false, authored: true, guide: { baseSha, headSha } })
      expect(authored?.guide.sections.flatMap((section) => section.files.map((file) => file.path))).toEqual(['change.txt'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})


test('session guide reads in a PR session never return that PR guide', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-pr-guide-handler-'))
  const previous = process.env.SOLUS_DATA_DIR
  process.env.SOLUS_DATA_DIR = directory
  try {
    const { writePrGuide } = await import('@solus/server/review/pr-guide-store')
    await writePrGuide(guide('PR guide'), target, () => true)
    const { SolusServer } = await import('@solus/server/transport/server')
    const { registerReviewHandlers } = await import('@solus/server/transport/handlers/review-handlers')
    const { TEST_HANDLER_CTX } = await import('./helpers/handler-ctx')
    const server = new SolusServer()
    registerReviewHandlers(server, {} as Parameters<typeof registerReviewHandlers>[1], {} as Parameters<typeof registerReviewHandlers>[2], {} as Parameters<typeof registerReviewHandlers>[3])
    const context = { session: {
      projectPath: directory, workingDirectory: directory,
      prReview: { ...target, branch: 'feature' },
    } } as IpcContext
    expect(await server.handle('readGuide', [context, 'session-another'], TEST_HANDLER_CTX)).toBeNull()
    expect(await server.handle('readGuide', [context, prGuideKey(target), target], TEST_HANDLER_CTX)).toMatchObject({ title: 'PR guide' })
  } finally {
    if (previous === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
