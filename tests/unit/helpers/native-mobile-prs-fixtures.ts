import type { PullRequest } from '@solus/contracts/providers'
import type { ProjectEntry } from '@solus/contracts/types'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './native-mobile-fakes'

export const project = (path: string, repositoryKey: string | null): ProjectEntry => ({
  key: path, path, folderName: path.split('/').pop()!, addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', repositoryKey,
})

export const pullRequest = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  number, url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, headSha: `head-${number}`, baseSha: 'base',
  baseRepo: { host: 'github.com', owner: 'o', repo: 'r' }, headRepo: { owner: 'o', repo: 'r', isFork: false },
  author: 'someone', authorAvatarUrl: '', state: 'open', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  draft: false, labels: [], additions: 1, deletions: 1, body: '', baseRef: 'main', headRef: 'feature', changedFiles: 1,
  mergeable: null, mergeStateStatus: null,
  capabilities: { diff: true, diffFileContents: true, inlineComments: true, threadReplies: true, threadResolution: true, reviewVerdicts: ['comment', 'approve', 'request-changes'], actions: [], mergeMethods: [], reviewerRequests: false, reviewerCandidates: false, labelManagement: false },
  viewerPermissions: { actions: [], reviewVerdicts: ['comment', 'approve', 'request-changes'], comment: true, resolveThreads: false, requestReviewers: false, manageLabels: false },
  ...overrides,
})

export const PR_REF = { hostId: 'inst-a', projectPath: '/work/app', number: 7 }

/** A detail read that answers every part. */
export function detailApi(api: FakeApi, pr: () => PullRequest = () => pullRequest(7)): FakeApi {
  return api
    .on('prGetOverview', () => ({ pullRequest: pr(), commits: [], reviewers: [] }))
    .on('prListComments', () => [])
    .on('prListThreads', () => [])
    .on('prChangedFiles', () => [])
    .on('prGetStack', () => null)
}

/** One saved host, `inst-a`, dialed and accepted when `connected`. */
export async function hostWorld(api: FakeApi, options: { connected?: boolean; hosts?: string[] } = {}) {
  const hosts = options.hosts ?? ['inst-a']
  const urls = Object.fromEntries(hosts.map((id, index) => [`http://h${index}:1`, id]))
  const world = createHostWorld({ fetch: healthFetch(urls), api: () => api })
  await world.registry.load()
  for (const [url, id] of Object.entries(urls)) await world.registry.savePaired({ id, label: id, url }, `t-${id}`)
  if (options.connected) {
    for (const id of hosts) world.connections.connection(id)
    for (const transport of world.transports) await transport.accept()
    await flushPromises()
  }
  return world
}

/** A promise the test settles by hand, for reads that land out of order. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
