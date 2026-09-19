import type { SessionRecord } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The session records of one organization, as its workspace service lists them
 * (docs/plans/cloud-service-model.md §12), for the page shell's Sessions page.
 * A record is what the runner reported; the transcript stays on the runner.
 */
export class PageSessionRecords {
  records = $state<SessionRecord[]>([])
  loading = $state(false)
  error = $state<string | null>(null)
  private loadSeq = 0

  constructor(private readonly serverId: string) {}

  async load(): Promise<void> {
    const seq = ++this.loadSeq
    this.loading = true
    this.error = null
    try {
      const records = await serverConnections.apiFor(this.serverId).sessionRecordList({ limit: 200 })
      if (seq !== this.loadSeq) return
      this.records = records.toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
    } catch (error) {
      if (seq !== this.loadSeq) return
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (seq === this.loadSeq) this.loading = false
    }
  }
}

/** The name a record row prints: what the person named it, else what it started with. */
export function sessionRecordTitle(record: SessionRecord): string {
  return record.customTitle?.trim() || record.title?.trim() || 'Untitled session'
}
