import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import type { AgentLinkedPullRequest } from '../../../providers/types'
import { providerForRepo } from '../../../providers/registry'
import type { CodeHost } from '../../../prs/code-host'
import type { RepoRef } from '@solus/contracts/providers'

type State = PullRequest['state']

interface Entry {
  link: SessionPullRequestLink
  known?: AgentLinkedPullRequest
  key: string
}

interface Layer {
  entry: Entry
  depth: number
}

interface Chain {
  kind: 'native' | 'derived'
  layers: Layer[]
}

function keyOf(link: SessionPullRequestLink) {
  return `${link.repository}#${link.number}`
}

/** Only a link for this exact PR permits an alternate repository target. */
export function linkedPullRequestRepository(links: SessionPullRequestLink[], current: RepoRef, selector: string, number: number): RepoRef | undefined {
  const name = selector.toLowerCase()
  const linked = links.find(link => link.number === number &&
    (link.repository === name || link.repository === `${current.host.toLowerCase()}/${name}`))
  if (!linked) return
  const parsed = parseGitHubPullRequestUrl(linked.url)
  if (parsed?.number === number && repositoryKeyOf(parsed.baseRepo) === linked.repository) return parsed.baseRepo
}

/** The caller must obtain these links through the admitted session read. A
 * cross-repo link uses the caller's account, without borrowing checkout auth. */
export async function readLinkedMetadata(links: SessionPullRequestLink[], checkout?: CodeHost) {
  const repositories = new Map<string, { target: CodeHost; numbers: number[] }>()
  for (const link of links) {
    const existing = repositories.get(link.repository)
    if (existing) {
      existing.numbers.push(link.number)
      continue
    }
    const parsed = parseGitHubPullRequestUrl(link.url)
    if (!parsed || repositoryKeyOf(parsed.baseRepo) !== link.repository) continue
    const provider = providerForRepo(parsed.baseRepo)
    const target = checkout && repositoryKeyOf(checkout.repo) === link.repository ? checkout
      : provider ? { repo: parsed.baseRepo, provider } : null
    if (target) repositories.set(link.repository, { target, numbers: [link.number] })
  }
  const metadata = new Map<string, AgentLinkedPullRequest>()
  const groups = [...repositories]
  for (let offset = 0; offset < groups.length; offset += 4) {
    await Promise.all(groups.slice(offset, offset + 4).map(async ([repository, { target, numbers }]) => {
      const rows = await target.provider.review.agentLinkedPullRequests?.(target.repo, numbers).catch(() => undefined)
      for (const [number, pr] of rows ?? []) if (pr) metadata.set(`${repository}#${number}`, pr)
    }))
  }
  return metadata
}

function nativeChains(entries: Entry[]): Chain[] {
  const native = new Map<string, Layer[]>()
  for (const entry of entries) {
    const stack = entry.known?.stack
    if (!stack) continue
    const key = `${entry.link.repository}#${stack.number}`
    const layers = native.get(key) ?? []
    layers.push({ entry, depth: stack.position })
    native.set(key, layers)
  }
  return [...native.values()].map(layers => ({
    kind: 'native', layers: layers.sort((a, b) => a.depth - b.depth).map((layer, index) => ({ ...layer, depth: index + 1 })),
  }))
}

function collectChains(entries: Entry[]): Chain[] {
  const chains = nativeChains(entries)
  // Match local branch chains only within one base repository. A fork can have
  // a branch with the same name and is not evidence of a stack on the base.
  const eligible = entries.filter(entry => entry.known && !entry.known.stack)
  const heads = new Map<string, Entry[]>()
  for (const entry of eligible) {
    if (entry.known!.isFork) continue
    const key = `${entry.link.repository}:${entry.known!.headRef}`
    heads.set(key, [...(heads.get(key) ?? []), entry])
  }
  const children = new Map<string, Entry[]>()
  const hasParent = new Set<string>()
  for (const entry of eligible) {
    const parents = heads.get(`${entry.link.repository}:${entry.known!.baseRef}`)
    if (parents?.length !== 1 || parents[0].key === entry.key) continue
    const parent = parents[0].key
    children.set(parent, [...(children.get(parent) ?? []), entry])
    hasParent.add(entry.key)
  }
  const placed = new Set<string>()
  for (const root of entries.filter(entry => !entry.known?.stack)) {
    if (hasParent.has(root.key)) continue
    const layers: Layer[] = []
    const pending: Layer[] = [{ entry: root, depth: 1 }]
    for (let layer = pending.pop(); layer; layer = pending.pop()) {
      if (placed.has(layer.entry.key)) continue
      placed.add(layer.entry.key)
      layers.push(layer)
      const below = children.get(layer.entry.key) ?? []
      for (let index = below.length - 1; index >= 0; index--) {
        pending.push({ entry: below[index], depth: layer.depth + 1 })
      }
    }
    chains.push({ kind: 'derived', layers })
  }
  for (const entry of eligible) {
    if (!placed.has(entry.key)) chains.push({ kind: 'derived', layers: [{ entry, depth: 1 }] })
  }
  return chains
}

function listPosition(link: SessionPullRequestLink) {
  return `${String(link.linkedAt).padStart(16, '0')} ${link.repository} ${String(link.number).padStart(10, '0')}`
}

export function threadPullRequestPage(
  links: SessionPullRequestLink[], metadata: ReadonlyMap<string, AgentLinkedPullRequest>,
  input: { cursor?: string; states?: State[] },
) {
  const entries = links.map(link => ({ link, known: metadata.get(keyOf(link)), key: keyOf(link) }))
  const chains = collectChains(entries)
  const membership = new Map<string, { kind: Chain['kind']; position: number; size: number }>()
  for (const chain of chains) {
    for (const { entry, depth } of chain.layers) {
      const size = chain.layers.length
      if (size > 1) membership.set(entry.key, { kind: chain.kind, position: depth, size })
    }
  }
  const after = entries.filter(({ link }) => !input.states || input.states.includes(link.snapshot?.state ?? 'open'))
    .map(entry => ({ ...entry, position: listPosition(entry.link) }))
    .filter(entry => !input.cursor || entry.position > input.cursor)
    .sort((a, b) => a.position.localeCompare(b.position))
  const page = after.slice(0, 50)
  const visible = new Set(page.map(entry => entry.key))
  return {
    pullRequests: page.map(({ link, known, key }) => {
      const [host, ...path] = link.repository.split('/')
      return {
        host, repository: path.join('/'), number: link.number, url: link.url,
        source: link.source, watching: !!link.watch, state: link.snapshot?.state ?? null, title: link.snapshot?.title ?? null,
        headBranch: known?.headRef ?? null, baseBranch: known?.baseRef ?? null, isDraft: link.snapshot?.draft ?? null,
        stack: membership.get(key) ?? null,
      }
    }),
    chains: chains.filter(chain => chain.layers.some(layer => visible.has(layer.entry.key)))
      .map(chain => ({ kind: chain.kind, numbers: chain.layers.map(layer => layer.entry.link.number) })),
    nextCursor: after.length > page.length ? page.at(-1)!.position : null,
  }
}
