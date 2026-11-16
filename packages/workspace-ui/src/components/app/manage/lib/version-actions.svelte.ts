import { appsStore } from '../../../../contexts/apps/apps.store.svelte'
import { requestInputFocus } from '../../../../lib/inputFocus'
import { toasts } from '../../../../lib/toasts'

/**
 * What the owner does on the Versions section, shared by its live card, its
 * change log, and its deploy history: which detail is open, which version
 * waits for a confirmation, and the deploy or the activation in progress.
 * One build at a time and one activation at a time.
 */
export class VersionActions {
  /** The open detail of one row: its source change, its build log, or a rollback's change. One at a time. */
  openDetail = $state<string | null>(null)
  /** The row whose activation waits for the owner's yes: a version made active runs at once and does not rewind data. */
  confirming = $state<string | null>(null)
  /** The revision a deploy from this page builds now. The host answers only when the build ended. */
  deployingCommit = $state<string | null>(null)
  isActivating = $state(false)

  constructor(private readonly target: () => { serverId: string; appId: string }) {}

  toggleDetail(key: string): void {
    this.openDetail = this.openDetail === key ? null : key
  }

  askToActivate(key: string): void {
    this.confirming = key
  }

  cancelActivation(): void {
    this.confirming = null
    requestInputFocus()
  }

  async deploy(commit: string): Promise<void> {
    if (this.deployingCommit !== null) return
    const { serverId, appId } = this.target()
    this.deployingCommit = commit
    try {
      const receipt = await appsStore.deploy(serverId, appId, commit)
      if (!receipt.active) toasts.error(`Version ${receipt.version} did not become active`, { description: receipt.error ?? 'The version before it still runs.' })
    } catch (cause) {
      toasts.error('The revision was not deployed', { description: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      this.deployingCommit = null
      requestInputFocus()
    }
  }

  async activate(version: number): Promise<void> {
    if (this.isActivating) return
    const { serverId, appId } = this.target()
    this.isActivating = true
    try {
      await appsStore.activate(serverId, appId, version)
      this.confirming = null
    } catch (cause) {
      toasts.error('The version did not become active', { description: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      this.isActivating = false
      requestInputFocus()
    }
  }
}
