import type { PullRequestCache } from '@solus/client-core/pull-request-cache'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { HostThreads } from './thread-directory'

/** Device copies use the same bounded SQLite response store as PRs. A scope
 * change ends every read and write opened by the previous account. */
export class MobileSessionCache {
  private readonly historyReads = new Map<string, Promise<SessionHistoryPage | null>>()

  constructor(private readonly storage: PullRequestCache, readonly scope: () => string) {}

  forHost(hostId: string) {
    const scope = this.scope()
    const key = (parts: readonly string[]) => JSON.stringify(['sessions-v1', scope, ...parts])
    const read = async <T>(parts: string[]) => {
      const value = await this.storage.read<T>(hostId, key(parts))
      return this.scope() === scope ? value : null
    }
    const write = <T>(parts: string[], value: T) =>
      this.scope() === scope ? this.storage.write(hostId, key(parts), value) : Promise.resolve()
    return {
      directory: () => read<HostThreads>(['directory']),
      clearDirectory: () => write(['directory'],null),
      saveDirectory: (directory: HostThreads) => write(['directory'], {
        ...directory, revision: directory.threads.length > 200 ? undefined : directory.revision, threads: directory.threads.slice(0, 200), unlisted: [],
      }),
      history: (sessionId: string) => {
        const id = JSON.stringify([scope, hostId, sessionId])
        const pending = this.historyReads.get(id)
        if (pending) return pending
        const result = read<SessionHistoryPage>(['history', sessionId]).finally(() => {
          if (this.historyReads.get(id) === result) this.historyReads.delete(id)
        })
        this.historyReads.set(id, result)
        return result
      },
      saveHistory: (sessionId: string, page: SessionHistoryPage | null) => {
        this.historyReads.delete(JSON.stringify([scope, hostId, sessionId]))
        return write(['history', sessionId], page)
      },
    }
  }
}
