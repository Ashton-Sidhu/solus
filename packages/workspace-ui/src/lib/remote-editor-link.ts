import type { EditorId } from '@solus/contracts/types'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'

export type SshTarget = NonNullable<ConnectionsServerInfo['sshTarget']>
export const REMOTE_EDITOR_IDS = ['vscode', 'cursor', 'zed'] as const satisfies readonly EditorId[]

export function remoteEditorLink(editorId: EditorId, target: SshTarget, absolutePath: string): string | null {
  if (!REMOTE_EDITOR_IDS.some((id) => id === editorId)) return null
  if (!absolutePath.startsWith('/') || !target.host || !target.user) return null
  const path = absolutePath.split('/').map(encodeURIComponent).join('/')
  const destination = `${target.user}@${target.host}`
  if (editorId === 'zed') return `zed://ssh/${encodeURIComponent(target.user)}@${encodeURIComponent(target.host)}${path}`
  return `${editorId}://vscode-remote/ssh-remote+${encodeURIComponent(destination)}${path}`
}
