import { serializeRoute } from '../workspace/routing/codec'

/**
 * The address that opens a task in the web app on the account origin: the app's
 * own route for the task on its organization's workspace service. Anyone in the
 * organization who opens it lands on the task; a task is not shared on its own.
 */
export function taskLinkUrl(accountOrigin: string, taskId: string, cloudServerId: string): string {
  return `${accountOrigin.replace(/\/$/, '')}/#${serializeRoute({ name: 'task', params: { taskId, serverId: cloudServerId } })}`
}
