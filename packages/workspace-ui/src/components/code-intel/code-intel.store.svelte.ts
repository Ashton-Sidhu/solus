import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type {
  CodeIntelDocsResult,
  CodeIntelExternalDocumentation,
  CodeIntelInstallRequest,
  CodeIntelInstallResult,
  CodeIntelReferencesRequest,
  CodeIntelReferencesResult,
  CodeIntelReindexRequest,
  CodeIntelStatus,
  CodeIntelSymbolRequest,
  CodeIntelSymbolResult,
} from '@solus/contracts/code-intel'
import type { IpcContext } from '@solus/contracts/types'
import { toasts } from '../../lib/toasts'
import { CodeIntelIndexToastTracker } from './lib/index-toasts'
import { canReuseSymbolAnswer } from './lib/symbol-cache'

/** Enough for one review's worth of clicks; the host answers a miss in one hop. */
const MAX_CACHED_ANSWERS = 300
const MAX_CACHED_REFERENCE_PAGES = 100

function statusKey(serverId: string, root: string): string {
  return `${serverId}|${root}`
}

/**
 * Per-host code-intelligence state: the index status of each project root and
 * a cache of answered positions. The host broadcasts every index transition,
 * and an index that changed can answer differently, so a transition drops the
 * whole answer cache rather than guessing which answers it touched.
 */
class CodeIntelStore {
  /** Keyed by host and the root the host resolved, as the status names it. */
  readonly statusByRoot = new SvelteMap<string, CodeIntelStatus>()
  /** Bumped on every host status change; an open card re-asks on the bump. */
  version = $state(0)
  private readonly answers = new Map<string, CodeIntelSymbolResult>()
  private readonly inFlight = new Map<string, Promise<CodeIntelSymbolResult>>()
  private readonly referencePages = new Map<string, CodeIntelReferencesResult>()
  private readonly referencePagesInFlight = new Map<string, Promise<CodeIntelReferencesResult>>()
  /** MDN summaries, keyed by host and page or query. Independent of any index,
   *  so an index rebuild leaves these alone. */
  private readonly summaries = new Map<string, CodeIntelDocsResult>()
  private readonly summariesInFlight = new Map<string, Promise<CodeIntelDocsResult>>()
  private readonly indexToasts = new CodeIntelIndexToastTracker((message) => toasts.progress(message))
  private isWatching = false

  private ensureWatching(): void {
    if (this.isWatching) return
    this.isWatching = true
    subscribeAllHosts('codeIntel.statusChanged', (serverId, status) => {
      this.indexToasts.update(serverId, status)
      this.statusByRoot.set(statusKey(serverId, status.root ?? ''), status)
      this.answers.clear()
      this.referencePages.clear()
      this.version++
    })
  }

  statusFor(serverId: string, root: string): CodeIntelStatus | undefined {
    return this.statusByRoot.get(statusKey(serverId, root))
  }

  /** Tool availability on the host, independent of any project. */
  hostStatusFor(serverId: string): CodeIntelStatus | undefined {
    return this.statusByRoot.get(statusKey(serverId, ''))
  }

  async loadStatus(serverId: string, api: HostApi, ctx: IpcContext | null, cwd: string | undefined): Promise<CodeIntelStatus> {
    this.ensureWatching()
    const status = await api.codeIntelStatus(ctx, { cwd })
    this.statusByRoot.set(statusKey(serverId, status.root ?? ''), status)
    return status
  }

  symbolAt(serverId: string, api: HostApi, ctx: IpcContext, request: CodeIntelSymbolRequest): Promise<CodeIntelSymbolResult> {
    this.ensureWatching()
    const key = `${serverId}|${request.cwd ?? ''}|${request.path}|${request.line}|${request.character}`
    const cached = this.answers.get(key)
    // A symbol answer remains valid until the host broadcasts the index
    // transition, which clears this cache and bumps `version`. Refusing a stale
    // symbol here makes every reader reissue the same request while that rebuild
    // runs; a reactive caller can then turn one stale answer into an RPC loop.
    if (canReuseSymbolAnswer(cached)) {
      return Promise.resolve(cached)
    }
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const promise = api
      .codeIntelSymbolAt(ctx, request)
      .then((result) => {
        if (result.ok) this.remember(key, result)
        return result
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, promise)
    return promise
  }

  /** Later pages are cached independently from the position answer. This keeps
   *  a reopened card fast without making the initial hover response unbounded. */
  references(
    serverId: string,
    api: HostApi,
    ctx: IpcContext,
    request: CodeIntelReferencesRequest,
  ): Promise<CodeIntelReferencesResult> {
    this.ensureWatching()
    const version = this.version
    const key = `${version}|${serverId}|${request.cwd ?? ''}|${request.language}|${request.symbol}|${request.offset}`
    const cached = this.referencePages.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.referencePagesInFlight.get(key)
    if (pending) return pending
    const promise = api
      .codeIntelReferences(ctx, request)
      .then((result) => {
        if (result.ok && this.version === version) {
          if (this.referencePages.size >= MAX_CACHED_REFERENCE_PAGES) {
            const oldest = this.referencePages.keys().next().value
            if (oldest !== undefined) this.referencePages.delete(oldest)
          }
          this.referencePages.set(key, result)
        }
        return result
      })
      .finally(() => {
        this.referencePagesInFlight.delete(key)
      })
    this.referencePagesInFlight.set(key, promise)
    return promise
  }

  /**
   * The MDN summary for a platform symbol. The host holds the real cache; this
   * one keeps a re-opened card from paying the round trip again, and dedupes
   * the clicks a reader makes on the same identifier twice in a row. A failure
   * is not remembered, so the next open can still reach the network.
   */
  docs(serverId: string, api: HostApi, reference: CodeIntelExternalDocumentation): Promise<CodeIntelDocsResult> {
    const key = `${serverId}|${reference.kind === 'article' ? reference.article : reference.query}`
    const cached = this.summaries.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.summariesInFlight.get(key)
    if (pending) return pending
    const promise = api
      .codeIntelDocs({ reference })
      .then((result) => {
        if (result.ok) this.summaries.set(key, result)
        return result
      })
      .finally(() => {
        this.summariesInFlight.delete(key)
      })
    this.summariesInFlight.set(key, promise)
    return promise
  }

  async reindex(serverId: string, api: HostApi, ctx: IpcContext, request: CodeIntelReindexRequest): Promise<void> {
    this.ensureWatching()
    const result = await api.codeIntelReindex(ctx, request)
    if (result.ok && result.status.root) {
      this.statusByRoot.set(statusKey(serverId, result.status.root), result.status)
    }
    this.answers.clear()
    this.referencePages.clear()
  }

  async install(serverId: string, api: HostApi, request: CodeIntelInstallRequest): Promise<CodeIntelInstallResult> {
    this.ensureWatching()
    const result = await api.codeIntelInstall(request)
    if (result.ok) this.statusByRoot.set(statusKey(serverId, ''), result.status)
    return result
  }

  private remember(key: string, result: CodeIntelSymbolResult): void {
    if (this.answers.size >= MAX_CACHED_ANSWERS) {
      const oldest = this.answers.keys().next().value
      if (oldest !== undefined) this.answers.delete(oldest)
    }
    this.answers.set(key, result)
  }
}

export const codeIntelStore = new CodeIntelStore()
