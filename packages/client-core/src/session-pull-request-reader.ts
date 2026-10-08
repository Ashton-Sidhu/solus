import type { HostApi } from './host-api'
import type { SessionPullRequestsBySession } from '@solus/contracts/session-pull-requests'

interface PendingRead {
  promise: Promise<SessionPullRequestsBySession>
  resolve(answer: SessionPullRequestsBySession): void
  reject(error: Error): void
}

/** Session-change events delivered across adjacent transport tasks share a
 * short, fixed batching window before the host read. Events after a read starts
 * queue another read: they may describe changes that the first read missed. */
export class SessionPullRequestReader {
  private readonly pending = new Map<string, PendingRead>()
  private inFlight = false

  constructor(
    private readonly api: Pick<HostApi, 'sessionPullRequestsList'>,
    private readonly schedule: (read: () => void) => void = (read) => { setTimeout(read, 50) },
  ) {}

  read(sessionId: string): Promise<SessionPullRequestsBySession> {
    const existing = this.pending.get(sessionId)
    if (existing) return existing.promise
    let resolve!: PendingRead['resolve']
    let reject!: PendingRead['reject']
    const promise = new Promise<SessionPullRequestsBySession>((yes, no) => { resolve = yes; reject = no })
    const first = this.pending.size === 0
    this.pending.set(sessionId, { promise, resolve, reject })
    if (first) this.schedule(() => this.flush())
    return promise
  }

  private flush(): void {
    if (this.inFlight || !this.pending.size) return
    const reads = [...this.pending.entries()]
    this.pending.clear()
    this.inFlight = true
    void Promise.resolve().then(() => this.api.sessionPullRequestsList(reads.map(([sessionId]) => sessionId))).then(
      (answer) => { for (const [, read] of reads) read.resolve(answer) },
      (error: Error) => { for (const [, read] of reads) read.reject(error) },
    ).finally(() => {
      this.inFlight = false
      this.flush()
    })
  }
}
