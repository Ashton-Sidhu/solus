import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StackEdge, StackGraph } from '../../shared/stack-types'
import type { PullRequestSummary } from '../../shared/providers'
import type { Provider, RepoRef } from '../providers/types'
import { getCliEnv } from '../cli-env'
import { createLogger } from '../logger'
import { runAsync } from './exec'

const log = createLogger('main', 'stack-detect')
const STACK_DETECT_INTERVAL_MS = 30_000
const STACKS_FILE = join('.solus', 'stacks.json')
const LOCAL_GIT_CONCURRENCY = 4
const PATCH_FALLBACK_PR_LIMIT = 20
const ANCESTRY_PEERS_PER_PR = 20

export interface StackPullRequestInput {
  number: number
  author: string
  body: string
  headSha: string
  files: string[]
  baseRef: string
  headRef: string
  isCrossRepository?: boolean
}

export interface StackDetectionFacts {
  ancestry: ReadonlySet<string>
  patchIds: ReadonlyMap<number, ReadonlySet<string>>
}

export interface StackDetectionDeps {
  repoRoot: string
  repo: RepoRef
  provider: Provider
  openPullRequests?: PullRequestSummary[]
  openPullRequestsComplete?: boolean
  onUpdate?: (graph: StackGraph) => void
}

const detectionInflight = new Map<string, Promise<StackGraph>>()
const lastDetectionStarted = new Map<string, number>()

export function stackPairKey(parent: number, child: number): string {
  return `${parent}:${child}`
}

export function patchIdsAreSubset(parent: ReadonlySet<string>, child: ReadonlySet<string>): boolean {
  if (parent.size === 0 || child.size <= parent.size) return false
  for (const patchId of parent) if (!child.has(patchId)) return false
  return true
}

/** Read explicit dependency prose plus the common ordered stack-list/table shape. */
export function parseDeclaredParents(body: string, child: number): number[] {
  const direct = new Set<number>()
  for (const match of body.matchAll(/\bdepends\s+on\s+#(\d+)\b/gi)) {
    const number = Number(match[1])
    if (number !== child) direct.add(number)
  }
  for (const match of body.matchAll(/\stacked\s+on\s+#(\d+)\b/gi)) {
    const number = Number(match[1])
    if (number !== child) direct.add(number)
  }
  if (direct.size > 0) return [...direct]

  const lines = body.split(/\r?\n/)
  const ordered: number[] = []
  let inStackList = false
  for (const line of lines) {
    if (/^\s{0,3}(?:#{1,6}\s*)?(?:pr\s+)?stack\b/i.test(line)) {
      inStackList = true
      continue
    }
    const isTableRow = inStackList && line.includes('|')
    const isListRow = inStackList && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)
    if (!isTableRow && !isListRow) {
      if (inStackList && line.trim() && ordered.length > 0) inStackList = false
      continue
    }
    const match = line.match(/#(\d+)\b/)
    if (match) ordered.push(Number(match[1]))
  }

  const childIndex = ordered.indexOf(child)
  if (childIndex <= 0) return []
  const parent = ordered[childIndex - 1]
  return parent === child ? [] : [parent]
}

/** Drop cached inferred edges when either endpoint is absent or has moved. */
export function invalidateStaleEdges(previous: StackGraph, currentHeadShas: Record<number, string>): StackEdge[] {
  return previous.edges.filter((edge) => {
    const parentHead = currentHeadShas[edge.parent]
    const childHead = currentHeadShas[edge.child]
    return !!parentHead
      && !!childHead
      && previous.headShas[edge.parent] === parentHead
      && previous.headShas[edge.child] === childHead
  })
}

/** Build one parent per child. Incomparable nearest candidates are deliberately left unrelated. */
export function buildStackGraph(
  pullRequests: StackPullRequestInput[],
  facts: StackDetectionFacts,
  previous: StackGraph | null,
  detectedAt = new Date().toISOString(),
  complete = true,
): StackGraph {
  const openNumbers = new Set(pullRequests.map((pr) => pr.number))
  const headShas = {
    ...(complete ? {} : previous?.headShas ?? {}),
    ...Object.fromEntries(pullRequests.map((pr) => [pr.number, pr.headSha])),
  } as Record<number, string>
  const edges: StackEdge[] = []
  const manualByChild = new Map<number, StackEdge>()
  const preservedChildren = new Set<number>()
  const addEdge = (edge: StackEdge): void => {
    if (!wouldCreateCycle(edges, edge.parent, edge.child)) edges.push(edge)
  }

  if (!complete) {
    for (const edge of previous?.edges ?? []) {
      if (edge.source !== 'manual' && (!openNumbers.has(edge.parent) || !openNumbers.has(edge.child))) {
        addEdge(edge)
        preservedChildren.add(edge.child)
      }
    }
  }

  // A manual pin is intent, not a cached heuristic. Keep it across head moves,
  // but never retain an endpoint that is no longer represented by an open PR.
  for (const edge of previous?.edges ?? []) {
    if (edge.source !== 'manual') continue
    if (edge.parent === edge.child) continue
    if (complete && (!openNumbers.has(edge.parent) || !openNumbers.has(edge.child))) continue
    if (!complete && (!openNumbers.has(edge.parent) || !openNumbers.has(edge.child))) {
      manualByChild.set(edge.child, edge)
      continue
    }
    manualByChild.set(edge.child, edge)
  }
  for (const edge of manualByChild.values()) addEdge(edge)

  const candidates = candidatePairs(pullRequests)
  const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]))
  for (const child of pullRequests) {
    if (manualByChild.has(child.number) || preservedChildren.has(child.number)) continue

    const declared = parseDeclaredParents(child.body, child.number)
      .filter((parent) => openNumbers.has(parent))
    const branchParent = pullRequests.find((parent) => (
      parent.number !== child.number
      && parent.isCrossRepository !== true
      && parent.headRef === child.baseRef
    ))
    const directParents = declared.length > 0 ? declared : branchParent ? [branchParent.number] : []
    if (directParents.length > 0) {
      if (directParents.length === 1) addEdge({ parent: directParents[0], child: child.number, source: 'declared' })
      continue
    }

    const possibleParents = pullRequests
      .filter((parent) => {
        const key = stackPairKey(parent.number, child.number)
        return candidates.has(key) || facts.ancestry.has(key)
      })
      .map((parent) => parent.number)
    const ancestorParents = possibleParents.filter((parent) => facts.ancestry.has(stackPairKey(parent, child.number)))
    if (ancestorParents.length > 0) {
      const nearest = nearestAncestryCandidates(ancestorParents, facts.ancestry)
      if (nearest.length === 1) addEdge({ parent: nearest[0], child: child.number, source: 'ancestry' })
      continue
    }

    const childPatchIds = facts.patchIds.get(child.number) ?? new Set<string>()
    const patchParents = possibleParents.filter((parent) => {
      const parentPatchIds = facts.patchIds.get(parent) ?? new Set<string>()
      return patchIdsAreSubset(parentPatchIds, childPatchIds)
    })
    if (patchParents.length === 0) continue
    const nearest = nearestPatchCandidates(patchParents, facts.patchIds)
    if (nearest.length === 1 && byNumber.has(nearest[0])) {
      addEdge({ parent: nearest[0], child: child.number, source: 'patchid' })
    }
  }

  return { edges: edges.sort(compareEdges), headShas, detectedAt }
}

export async function readStackGraph(repoRoot: string): Promise<StackGraph | null> {
  try {
    return JSON.parse(await readFile(join(repoRoot, STACKS_FILE), 'utf8')) as StackGraph
  } catch {
    return null
  }
}

export async function writeStackGraph(repoRoot: string, graph: StackGraph): Promise<void> {
  const path = join(repoRoot, STACKS_FILE)
  const tmp = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(graph, null, 2), 'utf8')
  // Readers see either the old complete graph or the new complete graph.
  await rename(tmp, path)
}

export function emptyStackGraph(): StackGraph {
  return { edges: [], headShas: {}, detectedAt: new Date(0).toISOString() }
}

export function scheduleStackDetection(deps: StackDetectionDeps): void {
  const lastStarted = lastDetectionStarted.get(deps.repoRoot) ?? 0
  if (detectionInflight.has(deps.repoRoot) || Date.now() - lastStarted < STACK_DETECT_INTERVAL_MS) return
  void detectStackGraph(deps).catch((err) => {
    log.warn(`stack detection failed for ${deps.repoRoot}: ${err instanceof Error ? err.message : String(err)}`)
  })
}

export function detectStackGraph(deps: StackDetectionDeps): Promise<StackGraph> {
  const active = detectionInflight.get(deps.repoRoot)
  if (active) return active

  lastDetectionStarted.set(deps.repoRoot, Date.now())
  const pending = detectStackGraphUncached(deps)
    .then((graph) => {
      deps.onUpdate?.(graph)
      return graph
    })
    .finally(() => {
      if (detectionInflight.get(deps.repoRoot) === pending) detectionInflight.delete(deps.repoRoot)
    })
  detectionInflight.set(deps.repoRoot, pending)
  return pending
}

/** Wait out a detection that may have captured pre-mutation host state, then
 * guarantee one fresh pass after a merge or force-push moves the stack. */
export async function redetectStackGraph(deps: StackDetectionDeps): Promise<StackGraph> {
  await detectionInflight.get(deps.repoRoot)?.catch(() => {})
  return detectStackGraph(deps)
}

export async function addManualStackEdge(repoRoot: string, parent: number, child: number): Promise<StackGraph> {
  await detectionInflight.get(repoRoot)
  const graph = (await readStackGraph(repoRoot)) ?? emptyStackGraph()
  if (parent === child) throw new Error('A pull request cannot be its own stack parent.')
  if (!graph.headShas[parent] || !graph.headShas[child]) {
    throw new Error('Manual stack edges can only connect open pull requests.')
  }

  const remaining = graph.edges.filter((edge) => edge.child !== child)
  if (wouldCreateCycle(remaining, parent, child)) throw new Error('That manual edge would create a stack cycle.')
  const manualEdge: StackEdge = { parent, child, source: 'manual' }
  const next: StackGraph = {
    ...graph,
    edges: [...remaining, manualEdge].sort(compareEdges),
    detectedAt: new Date().toISOString(),
  }
  await writeStackGraph(repoRoot, next)
  return next
}

export async function removeManualStackEdge(repoRoot: string, parent: number, child: number): Promise<StackGraph> {
  await detectionInflight.get(repoRoot)
  const graph = (await readStackGraph(repoRoot)) ?? emptyStackGraph()
  const next: StackGraph = {
    ...graph,
    edges: graph.edges.filter((edge) => !(edge.source === 'manual' && edge.parent === parent && edge.child === child)),
    detectedAt: new Date().toISOString(),
  }
  await writeStackGraph(repoRoot, next)
  return next
}

async function detectStackGraphUncached(deps: StackDetectionDeps): Promise<StackGraph> {
  const summaries = (deps.openPullRequests
    ?? await deps.provider.review.listPullRequests(deps.repo, { state: 'open' }))
    .filter((pr) => pr.state === 'open')
  const baseRefs = [...new Set(summaries.flatMap((summary) => summary.baseRef ? [summary.baseRef] : []))]
  const refspecs = [
    '+refs/pull/*/head:refs/solus/pr/*',
    ...baseRefs.map((baseRef) => `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`),
  ]
  const fetched = await runAsync('git', ['fetch', 'origin', ...refspecs], deps.repoRoot, { timeout: 120_000 })
    .then(() => true, (err) => {
      log.warn(`PR ref fetch failed; keeping only declared/manual stack facts: ${err instanceof Error ? err.message : String(err)}`)
      return false
    })

  const pullRequests: StackPullRequestInput[] = []
  for (const summary of summaries) {
    const fetchedHead = fetched
      ? await runAsync('git', ['rev-parse', `refs/solus/pr/${summary.number}`], deps.repoRoot).catch(() => summary.headSha)
      : summary.headSha
    pullRequests.push({
      number: summary.number,
      author: summary.author,
      body: summary.body ?? '',
      headSha: fetchedHead,
      files: [],
      baseRef: summary.baseRef ?? '',
      headRef: summary.headRef ?? '',
      isCrossRepository: summary.isCrossRepository,
    })
  }

  const ancestry = new Set<string>()
  const patchIds = new Map<number, ReadonlySet<string>>()
  if (fetched) {
    const containedInBase = new Map<string, ReadonlySet<number>>()
    for (const baseRef of baseRefs) {
      const merged = await runAsync(
        'git',
        ['for-each-ref', '--format=%(refname)', '--merged', `refs/remotes/origin/${baseRef}`, 'refs/solus/pr/*'],
        deps.repoRoot,
      ).catch(() => '')
      containedInBase.set(baseRef, new Set(
        merged.split('\n')
          .map((line) => Number(line.trim().match(/^refs\/solus\/pr\/(\d+)$/)?.[1]))
          .filter((number) => Number.isFinite(number)),
      ))
    }

    const candidates = ancestryCandidatePairs(pullRequests, containedInBase)
    await mapWithConcurrency([...candidates], LOCAL_GIT_CONCURRENCY, async (key) => {
      const [parent, child] = key.split(':').map(Number)
      const isAncestor = await runAsync(
        'git',
        ['merge-base', '--is-ancestor', pullRequests.find((pr) => pr.number === parent)!.headSha, pullRequests.find((pr) => pr.number === child)!.headSha],
        deps.repoRoot,
      ).then(() => true, () => false)
      if (isAncestor && parent !== child) ancestry.add(key)
    })

    const previous = await readStackGraph(deps.repoRoot)
    const preliminary = buildStackGraph(
      pullRequests,
      { ancestry, patchIds },
      previous,
      undefined,
      deps.openPullRequestsComplete ?? !deps.openPullRequests,
    )
    const related = new Set(preliminary.edges.flatMap((edge) => [edge.parent, edge.child]))
    const fallback = pullRequests.filter((pr) => !related.has(pr.number)).slice(0, PATCH_FALLBACK_PR_LIMIT)
    await mapWithConcurrency(fallback, LOCAL_GIT_CONCURRENCY, async (pr) => {
      pr.files = await deps.provider.review.listPullRequestFileStats(deps.repo, pr.number)
        .then((files) => files.map((file) => file.path), () => [])
      patchIds.set(pr.number, await readPatchIds(deps.repoRoot, pr).catch(() => new Set<string>()))
    })
  }

  const previous = await readStackGraph(deps.repoRoot)
  const graph = buildStackGraph(
    pullRequests,
    { ancestry, patchIds },
    previous,
    undefined,
    deps.openPullRequestsComplete ?? !deps.openPullRequests,
  )
  await writeStackGraph(deps.repoRoot, graph)
  return graph
}

/** A head already reachable from the child's base branch is contained in every
 * fresh branch cut from that base; its ancestry means "landed", not "stacked on". */
export function ancestryCandidatePairs(
  pullRequests: StackPullRequestInput[],
  containedInBase: ReadonlyMap<string, ReadonlySet<number>>,
): Set<string> {
  const pairs = new Set<string>()
  for (const child of pullRequests) {
    let peers = 0
    for (const parent of pullRequests) {
      if (parent.number === child.number || parent.author.toLowerCase() !== child.author.toLowerCase()) continue
      if (containedInBase.get(child.baseRef)?.has(parent.number)) continue
      pairs.add(stackPairKey(parent.number, child.number))
      if (++peers >= ANCESTRY_PEERS_PER_PR) break
    }
  }
  return pairs
}

async function mapWithConcurrency<T>(items: T[], limit: number, transform: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) await transform(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

function candidatePairs(pullRequests: StackPullRequestInput[]): Set<string> {
  const pairs = new Set<string>()
  const fileSets = new Map(pullRequests.map((pr) => [pr.number, new Set(pr.files)]))
  for (const parent of pullRequests) {
    if (!parent.author) continue
    for (const child of pullRequests) {
      if (parent.number === child.number || parent.author.toLowerCase() !== child.author.toLowerCase()) continue
      const parentFiles = fileSets.get(parent.number)!
      const childFiles = fileSets.get(child.number)!
      if ([...parentFiles].some((file) => childFiles.has(file))) pairs.add(stackPairKey(parent.number, child.number))
    }
  }
  return pairs
}

function nearestAncestryCandidates(candidates: number[], ancestry: ReadonlySet<string>): number[] {
  return candidates.filter((candidate) => !candidates.some((other) => (
    candidate !== other && ancestry.has(stackPairKey(candidate, other))
  )))
}

function nearestPatchCandidates(
  candidates: number[],
  patchIds: ReadonlyMap<number, ReadonlySet<string>>,
): number[] {
  return candidates.filter((candidate) => !candidates.some((other) => {
    if (candidate === other) return false
    const candidateIds = patchIds.get(candidate) ?? new Set<string>()
    const otherIds = patchIds.get(other) ?? new Set<string>()
    return patchIdsAreSubset(candidateIds, otherIds)
  }))
}

async function readPatchIds(repoRoot: string, detail: Pick<StackPullRequestInput, 'baseRef' | 'headSha'>): Promise<Set<string>> {
  const base = `refs/remotes/origin/${detail.baseRef}`
  const mergeBase = await runAsync('git', ['merge-base', base, detail.headSha], repoRoot)
  const patches = await runAsync(
    'git',
    ['log', '--no-merges', '--no-ext-diff', '--binary', '--pretty=format:%H', '--patch', `${mergeBase}..${detail.headSha}`],
    repoRoot,
    { maxBuffer: 32 * 1024 * 1024 },
  )
  if (!patches) return new Set()
  const output = await runWithInput('git', ['patch-id', '--stable'], patches, repoRoot)
  return new Set(output.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean))
}

function runWithInput(bin: string, args: string[], input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: getCliEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => child.kill(), 60_000)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim())
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${bin} exited ${code}`))
    })
    child.stdin.end(input)
  })
}

function wouldCreateCycle(edges: StackEdge[], parent: number, child: number): boolean {
  const children = new Map<number, number[]>()
  for (const edge of edges) children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge.child])
  const pending = [child]
  const seen = new Set<number>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === parent) return true
    if (seen.has(current)) continue
    seen.add(current)
    pending.push(...(children.get(current) ?? []))
  }
  return false
}

function compareEdges(a: StackEdge, b: StackEdge): number {
  return a.child - b.child || a.parent - b.parent || a.source.localeCompare(b.source)
}
