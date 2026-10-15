import type { RepoRef } from '@solus/contracts/providers'
import { z } from 'zod'
import type { GitHubClient } from './octokit'
import { githubRateLimitOf } from './rate-limit'
import { asBackgroundWork, isBackgroundWork } from './request-budget'

/** How long the first read waits for reads of other repositories to join its
 *  document (docs/plans/pr-sync.md §11). */
const WINDOW_MS = 10

/**
 * One kind of aliased read. A document reads items of many repositories of
 * one account. An item is one aliased field inside its repository:
 * `r0: repository(owner: $o0, name: $n0) { p7: pullRequest(number: 7) { ... } }`.
 */
export interface AliasedRead<Item> {
  operation: string
  /** The aliased field of one item, such as `p7: pullRequest(number: 7) { ... }`. */
  field: (item: Item) => string
  /** The fragments that the fields name. */
  fragments?: string
  /** GitHub prices a query by its nodes, so one document names at most this
   *  many items. */
  perDocument: number
}

/** The aliased field of one pull request by its number, `p<number>`. The
 *  number is written into the document, so only a safe integer goes in. */
export function pullRequestByNumber(selection: (number: number) => string): (number: number) => string {
  return (number) => {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('PR numbers must be positive integers.')
    return `p${number}: pullRequest(number: ${number}) { ${selection(number)} }`
  }
}

/** One repository's answer: each item by its alias. Null for a pull request
 *  number that the repository does not have. */
export type RepositoryRows<Row> = Partial<Record<string, Row | null>>

type AliasedAnswer<Row> = Partial<Record<string, RepositoryRows<Row> | null>>

interface PendingRead<Item, Row> {
  repo: RepoRef
  items: Item[]
  resolve: (rows: RepositoryRows<Row>) => void
  reject: (error: unknown) => void
}

/** The items of one read that one document holds. */
interface Part<Item, Row> {
  read: PendingRead<Item, Row>
  items: Item[]
}

const graphqlErrorSchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
})
type GraphqlError = z.output<typeof graphqlErrorSchema>

/**
 * Reads of different repositories on one account, sent together. A read
 * waits `WINDOW_MS` for others, and they go as shared aliased documents
 * instead of one document per repository.
 *
 * One repository's failure does not fail the others. An error that GitHub
 * places on one repository fails only the read of that repository, so its
 * credential chain can try the next credential. When a whole document fails,
 * each read in it is sent alone. A rate limit fails every read: another
 * request would only spend more of the same quota.
 */
export class HostBatches<Row, Item = number> {
  /** Reads that wait for their window, by client. Background work and the
   *  reads a person waits on go in different documents, because the request
   *  budget treats them differently (request-budget.ts). */
  private readonly waiting = { background: new Map<GitHubClient, PendingRead<Item, Row>[]>(), person: new Map<GitHubClient, PendingRead<Item, Row>[]>() }

  constructor(private readonly kind: AliasedRead<Item>) {}

  read(client: GitHubClient, repo: RepoRef, items: Item[]): Promise<RepositoryRows<Row>> {
    const background = isBackgroundWork()
    const queues = background ? this.waiting.background : this.waiting.person
    return new Promise((resolve, reject) => {
      const read = { repo, items, resolve, reject }
      const queue = queues.get(client)
      if (queue) {
        queue.push(read)
        return
      }
      queues.set(client, [read])
      setTimeout(() => {
        const reads = queues.get(client) ?? []
        queues.delete(client)
        const send = () => this.send(client, reads)
        void (background ? asBackgroundWork(send) : send())
      }, WINDOW_MS)
    })
  }

  private async send(client: GitHubClient, reads: PendingRead<Item, Row>[]): Promise<void> {
    const answers = new Map<PendingRead<Item, Row>, RepositoryRows<Row>>(reads.map((read) => [read, {}]))
    const failures = new Map<PendingRead<Item, Row>, unknown>()
    const alone = new Set<PendingRead<Item, Row>>()
    await Promise.all(documentsOf(reads, this.kind.perDocument).map(async (parts) => {
      let results: Array<RepositoryRows<Row> | Error>
      try {
        results = await readAliased(client, this.kind, parts)
      } catch (error) {
        const readers = new Set(parts.map(({ read }) => read))
        for (const read of readers) {
          if (readers.size > 1 && !githubRateLimitOf(error)) alone.add(read)
          else failures.set(read, error)
        }
        return
      }
      parts.forEach(({ read }, index) => {
        const result = results[index]
        if (result instanceof Error) failures.set(read, result)
        else Object.assign(answers.get(read) ?? {}, result)
      })
    }))
    await Promise.all(reads.map(async (read) => {
      if (failures.has(read)) read.reject(failures.get(read))
      else if (alone.has(read)) await this.send(client, [read])
      else read.resolve(answers.get(read) ?? {})
    }))
  }
}

/** Pack the reads into documents of at most `perDocument` items. A read
 *  with more items spans several documents. */
function documentsOf<Item, Row>(reads: PendingRead<Item, Row>[], perDocument: number): Array<Part<Item, Row>[]> {
  const documents: Array<Part<Item, Row>[]> = []
  let current: Part<Item, Row>[] = []
  let size = 0
  for (const read of reads) {
    for (let start = 0; start < read.items.length;) {
      if (size === perDocument) {
        documents.push(current)
        current = []
        size = 0
      }
      const items = read.items.slice(start, start + perDocument - size)
      current.push({ read, items })
      size += items.length
      start += items.length
    }
  }
  if (current.length) documents.push(current)
  return documents
}

/** The document for these parts. Owners and names go as variables; each
 *  field checks what it writes in. */
export function aliasedDocument<Item>(kind: AliasedRead<Item>, parts: Array<{ items: Item[] }>): string {
  const variables = parts.map((_, index) => `$o${index}: String!, $n${index}: String!`).join(', ')
  const repositories = parts.map((part, index) => `
    r${index}: repository(owner: $o${index}, name: $n${index}) {${part.items.map((item) => `
      ${kind.field(item)}`).join('')}
    }`).join('')
  return `query ${kind.operation}(${variables}) {${repositories}
  }
  ${kind.fragments ?? ''}`
}

/**
 * Send one document. Each part gets its repository's rows, or the error that
 * GitHub placed on that repository. Throws when the document failed as a
 * whole.
 */
async function readAliased<Item, Row>(client: GitHubClient, kind: AliasedRead<Item>, parts: Part<Item, Row>[]): Promise<Array<RepositoryRows<Row> | Error>> {
  const variables = Object.fromEntries(parts.flatMap((part, index) => [[`o${index}`, part.read.repo.owner], [`n${index}`, part.read.repo.repo]]))
  let answer: AliasedAnswer<Row>
  let errors: GraphqlError[] = []
  try {
    answer = await client.graphql<AliasedAnswer<Row>>(aliasedDocument(kind, parts), variables)
  } catch (error) {
    // GitHub answers what it can and names the rest in `errors`, and the
    // client throws for any error.
    const partial = z.object({
      data: z.custom<AliasedAnswer<Row>>((value) => typeof value === 'object' && value !== null),
      errors: z.array(graphqlErrorSchema),
    }).safeParse(error)
    // An error that names no repository can be about any of them.
    if (!partial.success || githubRateLimitOf(error) || partial.data.errors.some(({ path }) => !isRepositoryAlias(path?.[0]))) throw error
    answer = partial.data.data
    errors = partial.data.errors
  }
  return parts.map((part, index) => {
    const alias = `r${index}`
    const own = errors.filter(({ path }) => path?.[0] === alias)
    const repository = answer[alias]
    // A number that the repository does not have is an answer: GitHub gives
    // its alias null and a NOT_FOUND error at `r<index>.p<number>`.
    if (repository && own.every(({ type, path }) => type === 'NOT_FOUND' && path?.length === 2)) return repository
    // The errors go with the failure, so a FORBIDDEN or a hidden repository
    // moves to the next credential (octokit.ts).
    const message = own[0]?.message ?? `Repository ${part.read.repo.owner}/${part.read.repo.repo} was not found.`
    return Object.assign(new Error(message), { errors: own })
  })
}

function isRepositoryAlias(segment: string | number | undefined): boolean {
  return typeof segment === 'string' && /^r\d+$/.test(segment)
}
