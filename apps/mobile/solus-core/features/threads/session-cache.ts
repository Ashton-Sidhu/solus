import type { PullRequestCache } from '@solus/client-core/pull-request-cache'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { HostThreads } from './thread-directory'

/** Device copies use the same bounded SQLite response store as PRs. A scope
 * change ends every read and write opened by the previous account. */
export class MobileSessionCache {
  private readonly historyReads = new Map<string, Promise<SessionHistoryPage | null>>()
  /** History pages read from the host ahead of an open, until their copy is written. */
  private readonly historyFetches = new Map<string, Promise<SessionHistoryPage | null>>()

  constructor(private readonly storage: PullRequestCache, readonly scope: () => string) {}

  forHost(hostId: string) {
    const scope = this.scope()
    const key = (parts: readonly string[]) => JSON.stringify(['sessions-v1', scope, ...parts])
    const id = (sessionId: string) => JSON.stringify([scope, hostId, sessionId])
    const read = async <T>(parts: string[]) => {
      const value = await this.storage.read<T>(hostId, key(parts))
      return this.scope() === scope ? value : null
    }
    const write = <T>(parts: string[], value: T) =>
      this.scope() === scope ? this.storage.write(hostId, key(parts), value) : Promise.resolve()
    const diskHistory = (sessionId: string) => {
      const pending = this.historyReads.get(id(sessionId))
      if (pending) return pending
      const result = read<SessionHistoryPage>(['history-items', sessionId]).then(page =>
        page ?? read<SessionHistoryPage>(['history', sessionId])
      ).finally(() => {
        if (this.historyReads.get(id(sessionId)) === result) this.historyReads.delete(id(sessionId))
      })
      this.historyReads.set(id(sessionId), result)
      return result
    }
    const saveHistory = (sessionId: string, page: SessionHistoryPage | null) => {
      this.historyReads.delete(id(sessionId))
      if (page === null) return Promise.all([write(['history-items', sessionId], null), write(['history', sessionId], null)]).then(() => {})
      return write(['history-items', sessionId], page)
    }
    return {
      directory: () => read<HostThreads>(['directory']),
      clearDirectory: () => write(['directory'],null),
      saveDirectory: (directory: HostThreads) => {
        const pins = new Set(directory.opening?.pins.map(pin => pin.sessionId))
        const threads = directory.threads.filter((row, index) => index < 200 || pins.has(row.record.sessionId))
        return write(['directory'], {
          ...directory, revision: threads.length === directory.threads.length ? directory.revision : undefined,
          threads, unlisted: directory.unlisted?.filter(row => pins.has(row.record.sessionId)) ?? [],
        })
      },
      /** Reads which pages this device keeps for the host, so that `hasHistoryKey` answers true or false. */
      readKeys: () => this.storage.readResponseKeys(hostId),
      /** True while a prefetch is under way: its page is the saved page. Undefined until the keys are read. */
      hasHistoryKey: (sessionId: string) =>
        this.historyFetches.has(id(sessionId)) ||
        this.storage.hasResponseKey(hostId, key(['history-items', sessionId])) || this.storage.hasResponseKey(hostId, key(['history', sessionId])),
      /** When this device wrote its page of the session; undefined when it keeps none or the keys are not read yet. */
      historySavedAt: (sessionId: string) =>
        this.storage.responseWrittenAt(hostId, key(['history-items', sessionId])) ?? this.storage.responseWrittenAt(hostId, key(['history', sessionId])),
      /** The page a prefetch reads now, else the saved page. */
      history: (sessionId: string) => this.historyFetches.get(id(sessionId)) ?? diskHistory(sessionId),
      prefetching: (sessionId: string) => this.historyFetches.has(id(sessionId)),
      /**
       * Reads the page of a session ahead of its open and saves it. One read of
       * a session at a time: a second call gets the first read. `read` gets the
       * saved page, to send the blocks it holds. `isCurrent` is false when the
       * connection the read went on is gone: its page is then not kept.
       */
      prefetchHistory: (sessionId: string, readPage: (saved: () => Promise<SessionHistoryPage | null>) => Promise<SessionHistoryPage>, isCurrent: () => boolean) => {
        const held = this.historyFetches.get(id(sessionId))
        if (held) return held
        const fetch: Promise<SessionHistoryPage | null> = readPage(() => diskHistory(sessionId)).then(async page => {
          if (!isCurrent() || this.scope() !== scope) return null
          await saveHistory(sessionId, page)
          return page
        }, () => null).finally(() => {
          if (this.historyFetches.get(id(sessionId)) === fetch) this.historyFetches.delete(id(sessionId))
        })
        this.historyFetches.set(id(sessionId), fetch)
        return fetch
      },
      saveHistory,
    }
  }
}
