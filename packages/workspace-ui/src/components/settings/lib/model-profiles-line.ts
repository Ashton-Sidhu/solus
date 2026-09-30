import type { ModelProfilesStatus } from '@solus/contracts/types'
import { formatCheckedAt } from './update-status-text'

/** One line for the host's model list: where it came from and how fresh it is. */
export function modelProfilesLine(status: ModelProfilesStatus | undefined, now = Date.now()): string {
  if (!status) return 'Model list not reported by this host'
  if (status.checking) return 'Checking GitHub for the model list…'
  const source = status.source === 'remote' && status.fetchedAt !== null
    ? `From GitHub · updated ${formatCheckedAt(status.fetchedAt, now)}`
    : 'The list in this Solus build'
  return `${source} · checks daily at 3 PM Eastern`
}
