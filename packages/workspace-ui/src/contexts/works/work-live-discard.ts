import { toasts } from '../../lib/toasts'
import { clearLiveWorks, unsentLiveWorks } from './work-live-offline'

/**
 * Before this device forgets a host (or, with no host, every host), ask when
 * works still hold edits only this device has. Answers true when it asked:
 * `proceed` then runs only if the reader chooses to delete them. With nothing
 * unsent it deletes the device copies it knows and answers false.
 */
export function askBeforeDiscardingUnsent(serverId: string | undefined, proceed: () => void): boolean {
  const unsent = unsentLiveWorks(serverId)
  if (unsent.length === 0) {
    void clearLiveWorks(serverId)
    return false
  }
  const edits = unsent.reduce((sum, work) => sum + work.unsent, 0)
  const names = unsent.slice(0, 3).map((work) => `“${work.title}”`).join(', ')
  toasts.show({
    id: 'unsent-live-edits',
    variant: 'error',
    message: `${edits} unsent ${edits === 1 ? 'edit' : 'edits'} would be deleted`,
    description: `${names}${unsent.length > 3 ? ` and ${unsent.length - 3} more` : ''} ${unsent.length === 1 ? 'has' : 'have'} edits only this device holds. Reconnect to send them, or delete them and continue.`,
    duration: Number.POSITIVE_INFINITY,
    actions: [
      { label: 'Delete and continue', onAction: () => { void clearLiveWorks(serverId).then(proceed) } },
      { label: 'Keep', onAction: () => {} },
    ],
  })
  return true
}
