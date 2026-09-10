import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentToolContext } from '@solus/server/agents/tools/agent-tool'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuide, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { PrGuideJobDependencies, PrGuideJobRequest } from '@solus/server/review/pr-guide-jobs'
import type { ResolvedPrGuideTarget } from '@solus/server/review/pr-guide-context'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let PrGuideJobs: typeof import('@solus/server/review/pr-guide-jobs')['PrGuideJobs']
let prGuideKey: typeof import('@solus/server/review/pr-guide-store')['prGuideKey']
let prGuideRepository: typeof import('@solus/server/review/pr-guide-store')['prGuideRepository']
beforeAll(async () => {
  ;({ PrGuideJobs } = await import('@solus/server/review/pr-guide-jobs'))
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

function fixture(overrides: Partial<PrGuideJobDependencies> = {}) {
  let saved: ReviewGuide | null = null
  let current = target
  const events: ReviewGuideStatusEvent[] = []
  const dependencies: PrGuideJobDependencies = {
    current: async () => current,
    prepare: async (context, revision) => ({ ctx: context, target: revision }),
    author: async (_request, _context, revision, _signal, progress) => {
      progress('analyzing')
      const authored = { ...guide(), baseSha: revision.baseSha, headSha: revision.headSha }
      return { key: authored.key, guide: authored, persisted: false, authored: true }
    },
    read: async () => saved,
    write: async (value, _target, canCommit) => {
      if (!canCommit()) return false
      saved = value
      return true
    },
    ...overrides,
  }
  const jobs = new PrGuideJobs(dependencies)
  const request: PrGuideJobRequest = {
    ctx, dispatcher: {} as PrGuideJobRequest['dispatcher'], opts: { target },
    onStatus: (event) => events.push(event),
  }
  return {
    jobs, dependencies, request, events,
    setSaved: (value: ReviewGuide | null) => { saved = value },
    getSaved: () => saved,
    setCurrent: (value: ResolvedPrGuideTarget) => { current = value },
  }
}

describe('one host job per pull request', () => {
  test('queued state is readable before provider or checkout preparation', async () => {
    const preparing = deferred<void>()
    const started = deferred<void>()
    const f = fixture({ prepare: async (context, revision) => {
      started.resolve()
      await preparing.promise
      return { ctx: context, target: revision }
    } })
    const run = f.jobs.request(f.request)
    expect(run.status.status).toBe('queued')
    expect((await f.jobs.status(ctx, target))?.generationId).toBe(run.status.generationId)
    await started.promise
    const anotherClient = { session: { projectPath: '/other-project' } } as IpcContext
    expect((await f.jobs.status(anotherClient, target))?.status).toBe('generating')
    preparing.resolve()
    expect((await run.completion)?.persisted).toBe(true)
    expect(f.events.map((event) => event.status)).toContain('ready')
  })

  test('cancel during preparation stops the model and preserves the old guide', async () => {
    const preparing = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture({
      prepare: async (context, revision) => { started.resolve(); await preparing.promise; return { ctx: context, target: revision } },
      author: async () => { authors++; return null },
    })
    f.setSaved(guide('Old guide'))
    const run = f.jobs.request(f.request)
    await started.promise
    expect(f.jobs.cancel(target)).toBe(true)
    expect((await f.jobs.status(ctx, target))?.status).toBe('cancelled')
    preparing.resolve()
    expect(await run.completion).toBeNull()
    expect(authors).toBe(0)
    expect(f.getSaved()?.title).toBe('Old guide')
  })

  test('a later request cancels its predecessor and only the replacement writes', async () => {
    const authored = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture({ author: async (_request, _context, _revision, signal) => {
      const sequence = ++authors
      if (sequence === 1) { started.resolve(); await authored.promise; expect(signal.aborted).toBe(true) }
      const value = guide(`Guide ${sequence}`)
      return { key: value.key, guide: value, authored: true, persisted: false }
    } })
    const first = f.jobs.request(f.request)
    await started.promise
    const second = f.jobs.request({ ...f.request, ctx: { session: { projectPath: '/another-checkout' } } as IpcContext })
    expect(second.status.generationId).not.toBe(first.status.generationId)
    expect((await f.jobs.status(ctx, target))?.status).toBe('queued')
    authored.resolve()
    expect(await first.completion).toBeNull()
    expect((await second.completion)?.persisted).toBe(true)
    expect(f.getSaved()?.title).toBe('Guide 2')
  })

  test('a queued request can be cancelled while another PR runs', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    let authors = 0
    const f = fixture({ author: async () => { authors++; started.resolve(); await gate.promise; return null } })
    const first = f.jobs.request(f.request)
    await started.promise
    const other = { ...target, number: 43 }
    const second = f.jobs.request({ ...f.request, opts: { target: other } })
    expect((await f.jobs.status(ctx, other))?.status).toBe('queued')
    expect(f.jobs.cancel(other)).toBe(true)
    gate.resolve()
    await first.completion
    await second.completion
    expect(authors).toBe(1)
  })

  test('model failure and save failure are failed, with the last saved guide intact', async () => {
    for (const failure of ['author', 'write']) {
      const f = fixture(failure === 'author' ? { author: async () => null } : { write: async () => false })
      f.setSaved(guide('Keep me'))
      await f.jobs.request(f.request).completion
      expect(f.events.at(-1)?.status).toBe('failed')
      expect(f.getSaved()?.title).toBe('Keep me')
    }
  })

  test('base changes during generation make the result outdated even with an unchanged head', async () => {
    const f = fixture()
    f.setSaved(guide('Old guide'))
    f.dependencies.author = async () => {
      f.setCurrent({ ...target, baseSha: 'base-b' })
      return { key: prGuideKey(target), guide: guide('Discard me'), authored: true, persisted: false }
    }
    const result = await f.jobs.request(f.request).completion
    expect(result?.outdated).toBe(true)
    expect(result?.persisted).toBe(false)
    expect(f.getSaved()?.title).toBe('Old guide')
    expect(f.events.at(-1)).toMatchObject({ status: 'outdated', headSha: 'head-a', baseSha: 'base-b' })
  })

  test('fresh clients compare both current provider revisions to the saved guide', async () => {
    const f = fixture()
    f.setSaved(guide())
    expect((await f.jobs.status(ctx, target))?.status).toBe('ready')
    f.setCurrent({ ...target, baseSha: 'retargeted-base' })
    expect(await f.jobs.status(ctx, target)).toMatchObject({
      status: 'outdated', headSha: 'head-a', baseSha: 'retargeted-base', generatedAt: guide().generatedAt,
    })
    const restarted = new PrGuideJobs(f.dependencies)
    expect((await restarted.status(ctx, target))?.status).toBe('outdated')
  })

  test('an old status probe cannot hide a generation that starts while it waits', async () => {
    const probe = deferred<ReviewGuide | null>()
    const runGate = deferred<void>()
    const f = fixture({ read: async () => probe.promise, prepare: async (context, revision) => {
      await runGate.promise
      return { ctx: context, target: revision }
    } })
    const oldProbe = f.jobs.status(ctx, target)
    const run = f.jobs.request(f.request)
    probe.resolve(guide())
    expect((await oldProbe)?.generationId).toBe(run.status.generationId)
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
      const otherContext = { session: { projectPath: '/different-project' } } as IpcContext
      expect((await readPrGuide(otherContext, target))?.title).toBe('First')
      expect(await writePrGuide(guide('Replacement'), { ...target, headSha: 'head-b' }, () => true)).toBe(true)
      expect((await readPrGuide(ctx, target))?.title).toBe('Replacement')
      expect(readdirSync(dirname(prGuidePath(target)))).toEqual([`${prGuideKey(target)}.json`])
    } finally {
      if (previous === undefined) delete process.env.SOLUS_DATA_DIR
      else process.env.SOLUS_DATA_DIR = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a guide from an old managed revision is recovered without checking out that revision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solus-pr-guide-migration-'))
    const previous = process.env.SOLUS_DATA_DIR
    process.env.SOLUS_DATA_DIR = directory
    try {
      const { writeGuide } = await import('@solus/server/review/ledger')
      const { readPrGuide, prGuidePath } = await import('@solus/server/review/pr-guide-store')
      const old = guide('Old revision')
      delete old.target
      expect(await writeGuide('/retired/managed-checkout-for-head-a', old)).toBe(true)
      const current = { ...target, headSha: 'head-b', baseSha: 'base-b' }
      const recovered = await readPrGuide(ctx, current)
      expect(recovered).toMatchObject({ title: 'Old revision', headSha: 'head-a', baseSha: 'base-a' })
      expect(recovered?.target).toMatchObject({ headSha: 'head-a', baseSha: 'base-a' })
      expect(readdirSync(dirname(prGuidePath(current)))).toEqual([`${prGuideKey(current)}.json`])
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
            provider: input.provider, cwd: input.cwd, sessionId: () => undefined,
            solusSessionId: () => undefined, abortSignal: new AbortController().signal,
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
      const { authorPrGuide } = await import('@solus/server/review/guide-producer')
      const authored = await authorPrGuide(dispatcher, context, {
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
    const { SolusServer } = await import('@solus/server/server/server')
    const { registerReviewHandlers } = await import('@solus/server/server/handlers/review-handlers')
    const { TEST_HANDLER_CTX } = await import('./helpers/handler-ctx')
    const server = new SolusServer()
    registerReviewHandlers(server, {} as AgentDispatcher, {} as Parameters<typeof registerReviewHandlers>[2])
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
