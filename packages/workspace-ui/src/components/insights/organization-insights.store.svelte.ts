import type { WorkspaceInsightQuery, WorkspaceInsightPage } from '@solus/contracts/solus-api'
import { serverConnections } from '@solus/client-core/server-connections'

export const ORGANIZATION_TURNS_LIMIT = 200

/** One bounded page. Host and organization changes invalidate all pending reads and cursors. */
class OrganizationInsightsStore {
  result = $state<WorkspaceInsightPage | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)
  hasPrevious = $state(false)
  private loadToken = 0
  private source: { serverId: string; query: WorkspaceInsightQuery } | null = null
  private cursors: (string | undefined)[] = [undefined]
  private pageIndex = 0

  async load(serverId: string, query: WorkspaceInsightQuery): Promise<void> {
    this.reset()
    this.source = { serverId, query }
    await this.readPage(0, undefined)
  }

  private async readPage(index: number, cursor: string | undefined): Promise<void> {
    const source = this.source
    if (!source) return
    const token = ++this.loadToken
    this.loading = true; this.error = null
    try {
      const result = await serverConnections.apiFor(source.serverId).insightsList({ ...source.query, cursor })
      if (token !== this.loadToken) return
      this.result = result; this.pageIndex = index; this.cursors[index] = cursor; this.hasPrevious = index > 0
    } catch (error) {
      if (token !== this.loadToken) return
      this.error = error instanceof Error ? error.message : String(error)
    } finally { if (token === this.loadToken) this.loading = false }
  }

  async next(): Promise<void> {
    if (this.loading || !this.result?.nextCursor) return
    await this.readPage(this.pageIndex + 1, this.result.nextCursor)
  }
  async previous(): Promise<void> {
    if (this.loading || this.pageIndex === 0) return
    await this.readPage(this.pageIndex - 1, this.cursors[this.pageIndex - 1])
  }
  reset(): void {
    this.loadToken++; this.source = null; this.result = null; this.loading = false; this.error = null
    this.cursors = [undefined]; this.pageIndex = 0; this.hasPrevious = false
  }
}
export const organizationInsightsStore = new OrganizationInsightsStore()
