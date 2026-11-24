import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { DiffFileContentsRequest, DiffRequest, IpcContext, TurnSnapshot } from '@solus/contracts/types'
import type { DiffRepositoryTurnsStore as TurnsStoreClass } from '@solus/workspace-ui/components/diff/diff-repository-turns.store.svelte'
import type { DiffRepository } from '@solus/workspace-ui/components/diff/lib/diff-repositories'
import type { DiffState as DiffStateClass } from '@solus/workspace-ui/lib/diff-state.svelte'

// A session that works in `web` and has the session folder `api`
// (docs/plans/codebases.md §8). The diff panel reads one repository at a time.
const API = '/work/api'
const ctx = {} as IpcContext

const WEB_PATCH = `diff --git a/src/web.ts b/src/web.ts
index 1111111..2222222 100644
--- a/src/web.ts
+++ b/src/web.ts
@@ -1 +1 @@
-old
+new
`
const API_PATCH = `diff --git a/src/api.ts b/src/api.ts
index 3333333..4444444 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1 +1 @@
-old
+new
`

type GlobalWithState = { $state?: unknown }
const previousState = (globalThis as GlobalWithState).$state
let DiffState: typeof DiffStateClass
let DiffRepositoryTurnsStore: typeof TurnsStoreClass

beforeAll(async () => {
  ;(globalThis as GlobalWithState).$state = Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value })
  ;({ DiffState } = await import('@solus/workspace-ui/lib/diff-state.svelte'))
  ;({ DiffRepositoryTurnsStore } = await import('@solus/workspace-ui/components/diff/diff-repository-turns.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as GlobalWithState).$state
  else (globalThis as GlobalWithState).$state = previousState
})

function turn(index: number, traceId: string): TurnSnapshot {
  return {
    index,
    fromTreeSha: 'from',
    toTreeSha: 'to',
    sha: 'sha',
    timestamp: index,
    partial: false,
    userMessagePreview: '',
    traceId,
    filesChanged: 1,
    additions: 1,
    deletions: 0,
  }
}

/** A host that answers each repository with its own patch and records what it was asked. */
function fakeHost() {
  const diffRequests: DiffRequest[] = []
  const fileRequests: DiffFileContentsRequest[] = []
  const turnRequests: (string | undefined)[] = []
  const api = {
    diff: async (_ctx: IpcContext, request: DiffRequest) => {
      diffRequests.push(request)
      return { patch: request.repositoryPath === API ? API_PATCH : WEB_PATCH }
    },
    diffFileContents: async (_ctx: IpcContext, request: DiffFileContentsRequest) => {
      fileRequests.push(request)
      return {
        oldFile: { name: request.path, contents: 'old\n', cacheKey: 'old' },
        newFile: { name: request.path, contents: 'new\n', cacheKey: 'new' },
      }
    },
    listTurnSnapshots: async (_ctx: IpcContext, repositoryPath?: string) => {
      turnRequests.push(repositoryPath)
      return repositoryPath === API ? [turn(0, 'trace-c')] : [turn(0, 'trace-a'), turn(1, 'trace-b'), turn(2, 'trace-c')]
    },
  }
  return { api, diffRequests, fileRequests, turnRequests }
}

function diffStateOn(host: ReturnType<typeof fakeHost>, repository: { path: string | undefined }): DiffStateClass {
  return new DiffState({
    session: {} as never,
    getTabId: () => 'tab',
    getCtx: () => ctx,
    getApi: () => host.api as never,
    getRepositoryPath: () => repository.path,
  })
}

describe('the diff state of one repository of a session', () => {
  test('the diff request names the chosen session folder, and names none for the working directory', async () => {
    const host = fakeHost()
    const repository: { path: string | undefined } = { path: undefined }
    const state = diffStateOn(host, repository)

    await state.refresh({ kind: 'session' })
    expect(host.diffRequests.at(-1)).toEqual({ scope: { kind: 'session' } })
    expect(state.fileDiffs.map((file) => file.name)).toEqual(['src/web.ts'])

    repository.path = API
    await state.refresh({ kind: 'session' })
    expect(host.diffRequests.at(-1)).toEqual({ scope: { kind: 'session' }, repositoryPath: API })
    expect(state.fileDiffs.map((file) => file.name)).toEqual(['src/api.ts'])
  })

  test('full file contents are read from the same repository as the patch', async () => {
    // A file path is from its repository: `src/api.ts` read in the working
    // directory would be a different file, or none.
    const host = fakeHost()
    const state = diffStateOn(host, { path: API })
    await state.refresh({ kind: 'turn', index: 0 })
    await state.loadDiffFiles(state.fileDiffs[0]!)
    expect(host.fileRequests[0]).toMatchObject({ scope: { kind: 'turn', index: 0 }, repositoryPath: API, path: 'src/api.ts' })
  })

  test('the working directory asks for file contents with no repository', async () => {
    const host = fakeHost()
    const state = diffStateOn(host, { path: undefined })
    await state.refresh({ kind: 'session' })
    await state.loadDiffFiles(state.fileDiffs[0]!)
    expect('repositoryPath' in host.fileRequests[0]!).toBe(false)
  })

  test('the parsed patch is kept for each repository, so a move back does not parse again', async () => {
    // The scope alone is not a key: the session scope of `api` must not
    // replace the parsed session scope of the working directory.
    const host = fakeHost()
    const repository: { path: string | undefined } = { path: undefined }
    const state = diffStateOn(host, repository)

    await state.refresh({ kind: 'session' })
    const webFiles = state.fileDiffs
    repository.path = API
    await state.refresh({ kind: 'session' })
    expect(state.fileDiffs).not.toBe(webFiles)
    repository.path = undefined
    await state.refresh({ kind: 'session' })
    expect(state.fileDiffs).toBe(webFiles)
  })
})

describe('the turn list of one repository', () => {
  const web: DiffRepository = { path: '/work/web', name: 'web', isWorkingDirectory: true }
  const api: DiffRepository = { path: API, name: 'api', isWorkingDirectory: false }

  /** A workspace whose lifecycle store has the working directory's list, as the transcript reads it. */
  function workspaceOn(host: ReturnType<typeof fakeHost>) {
    const turnSnapshots: Record<string, TurnSnapshot[]> = {}
    return {
      lifecycle: {
        turnSnapshots,
        refreshTurnSnapshots: async (sessionId: string) => {
          turnSnapshots[sessionId] = await host.api.listTurnSnapshots(ctx)
        },
      },
      apiFor: () => host.api,
      ctxFor: () => ctx,
      sessionFor: () => ({ id: 'session-1' }),
    } as never
  }

  test('a session folder reads its own list from the host by its path', async () => {
    const host = fakeHost()
    const store = new DiffRepositoryTurnsStore()
    expect(store.turnsFor('session-1', API)).toBeUndefined()
    await store.refresh(host.api as never, ctx, 'session-1', API)
    expect(host.turnRequests).toEqual([API])
    expect(store.turnsFor('session-1', API)?.map((each) => each.traceId)).toEqual(['trace-c'])
  })

  test('a move to a session folder keeps the selected turn by its trace', async () => {
    const host = fakeHost()
    const store = new DiffRepositoryTurnsStore()
    const scope = await store.scopeAcross(workspaceOn(host), 'tab', web, api, { kind: 'turn', index: 2 })
    expect(scope).toEqual({ kind: 'turn', index: 0 })
    // One read for each repository: the working directory's list and the folder's.
    expect(host.turnRequests).toEqual([undefined, API])
  })

  test('a scope that is not a turn moves with no read', async () => {
    const host = fakeHost()
    const store = new DiffRepositoryTurnsStore()
    expect(await store.scopeAcross(workspaceOn(host), 'tab', web, api, { kind: 'session' })).toEqual({ kind: 'session' })
    expect(host.turnRequests).toEqual([])
  })

  test('an older answer that arrives after a newer one does not replace it', async () => {
    const store = new DiffRepositoryTurnsStore()
    let releaseFirst: (turns: TurnSnapshot[]) => void = () => {}
    const answers: Promise<TurnSnapshot[]>[] = [
      new Promise((resolve) => { releaseFirst = resolve }),
      Promise.resolve([turn(0, 'trace-c'), turn(1, 'trace-d')]),
    ]
    const api = { listTurnSnapshots: () => answers.shift()! } as never
    const first = store.refresh(api, ctx, 'session-1', API)
    await store.refresh(api, ctx, 'session-1', API)
    releaseFirst([turn(0, 'trace-c')])
    await first
    expect(store.turnsFor('session-1', API)?.length).toBe(2)
  })
})
