import { isSolusApiId } from '@solus/contracts/uplink'
import { accountStore } from '../account/account.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { sharesStore } from '../sharing/shares.store.svelte'
import type { CloudPublication } from '../sharing/cloud-publication'
import { appLinkUrl } from '../sharing/app-link'
import { toasts } from '../../lib/toasts'
import { publishProblemMessage } from '../../components/sharing/lib/publish-copy'

/**
 * A task is not shared on its own: everyone in its organization sees it
 * (docs/plans/cloud-sharing.md §4a). Its link is the app's address for it on
 * the account origin. Copy link puts a Local task in the window's organization
 * first, with its comments and its linked Local works, then copies that address.
 */
export class TaskLinks {
  constructor(private readonly publication: CloudPublication) {}

  /** Whether a task on this host can have a link: it is in an organization, or can be put in one. */
  canCopy(serverId: string): boolean {
    return accountStore.state.kind === 'signed-in' && (isSolusApiId(serverId) || !!serversStore.activeOrganizationId)
  }

  async copy(serverId: string, taskId: string): Promise<void> {
    const account = accountStore.state
    const accountOrigin = account.kind === 'signed-in' ? account.consoleUrl : null
    if (!accountOrigin) {
      toasts.error('Sign in to Solus Cloud to copy a link to this task.')
      return
    }
    let cloudServerId = serverId
    if (!isSolusApiId(serverId)) {
      const organizationId = serversStore.activeOrganizationId
      const organizationName = serversStore.activeOrganizationName ?? 'your organization'
      if (!organizationId) {
        toasts.error('Select an organization before copying a link.', {
          description: 'A task link opens the task in your organization on Solus Cloud.',
        })
        return
      }
      const outcome = await this.publication.upload({ serverId, resource: { kind: 'task', id: taskId }, organizationId })
      if (outcome.kind !== 'committed') {
        toasts.error(`Couldn't put this task in ${organizationName}`, { description: publishProblemMessage(outcome, 'task', organizationName) ?? undefined })
        return
      }
      cloudServerId = outcome.cloudServerId
    }
    try {
      await navigator.clipboard.writeText(appLinkUrl(accountOrigin, { kind: 'task', id: taskId }, cloudServerId))
      toasts.success('Link copied', { description: 'Anyone in your organization can open this task.' })
    } catch {
      toasts.error("Couldn't copy the link")
    }
  }
}

export const taskLinks = new TaskLinks(sharesStore.publication)
