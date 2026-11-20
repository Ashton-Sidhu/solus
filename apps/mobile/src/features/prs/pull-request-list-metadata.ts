import type { HostConnection } from '../hosts/host-connections'
import { projectContext } from '../conversation/lib/ipc-context'
import { hasSavedGuide, prGuideTarget } from './lib/pull-request-guide-state'
import { pullRequestRowKey, type PullRequestRow } from './lib/pull-request-list'
import { Listeners } from '../../lib/listeners'
export interface PrListMetadataState {
  rowsKey: string
  values: ReadonlyMap<string, { guide: boolean; lens: boolean }>
  pending: boolean
  error: string | null
}
/** Only local review records, batched by host and checkout. Never starts an agent or reads GitHub. */
export class PullRequestListMetadata {
  readonly changes = new Listeners()
  #state: PrListMetadataState = { rowsKey: '', values: new Map(), pending: false, error: null }
  #generation = 0
  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly organizationId: () => string | null
  ) {}
  current = (): PrListMetadataState => this.#state
  #set(state: PrListMetadataState): void {
    this.#state = state
    this.changes.notify()
  }
  reset(): void {
    this.#generation++
    this.#set({ rowsKey: '', values: new Map(), pending: false, error: null })
  }
  async load(rows: readonly PullRequestRow[]): Promise<void> {
    const generation = ++this.#generation
    const rowsKey = prMetadataRowsKey(rows)
    this.#set({ ...this.#state, rowsKey, pending: true, error: null })
    const groups = new Map<string, PullRequestRow[]>()
    for (const row of rows) {
      const key = `${row.hostId}\0${row.projectPath}`
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }
    const values = new Map<string, { guide: boolean; lens: boolean }>()
    for (const row of rows) {
      const key = prMetadataKey(row),
        previous = this.#state.values.get(key)
      if (previous) values.set(key, previous)
    }
    try {
      // Sequential project batches bound work on hosts that share a filesystem.
      for (const group of groups.values()) {
        const first = group[0]!,
          connection = this.connectionFor(first.hostId)
        if (!connection || connection.state.readiness !== 'ready')
          throw new Error('Connect the PR host to filter saved review records.')
        const ctx = projectContext(first.projectPath, this.organizationId())
        for (let offset = 0; offset < group.length; offset += 100) {
          const batch = group.slice(offset, offset + 100),
            targets = batch.map((row) => prGuideTarget(row.pr))
          const [guides, lenses] = await Promise.all([
            connection.api.prGuideStatuses(
              ctx,
              targets.map((target) => ({ target }))
            ),
            connection.api.prLensRevisions(ctx, targets)
          ])
          if (generation !== this.#generation) return
          for (const [index, row] of batch.entries())
            values.set(prMetadataKey(row), {
              guide: hasSavedGuide(guides[index] ?? null),
              lens: (lenses[index] ?? 0) > 0
            })
        }
      }
      if (generation === this.#generation)
        this.#set({ rowsKey, values, pending: false, error: null })
    } catch (error) {
      if (generation === this.#generation)
        this.#set({
          rowsKey,
          values,
          pending: false,
          error: error instanceof Error ? error.message : String(error)
        })
    }
  }
}

export function prMetadataKey(row: PullRequestRow): string {
  return JSON.stringify([pullRequestRowKey(row), row.projectPath, row.pr.headSha])
}
export function prMetadataRowsKey(rows: readonly PullRequestRow[]): string {
  return rows.map(prMetadataKey).join('\n')
}
