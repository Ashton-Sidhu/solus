import type { EditorId } from '@solus/contracts/types'
import { isAbsoluteHostPath, isWindowsHostPath } from '@solus/contracts/host-path'

export interface SshTarget { host: string; user?: string }
export const REMOTE_EDITOR_IDS = ['vscode', 'cursor', 'zed'] as const satisfies readonly EditorId[]

/** The saved target belongs to the viewer's machine. The editor resolves its alias with local SSH config. */
export function savedEditorSshTarget(target: string): SshTarget | undefined {
  const separator = target.lastIndexOf('@')
  const host = target.slice(separator + 1).replace(/:\d+$/, '')
  const user = separator < 0 ? undefined : target.slice(0, separator)
  if (!validDestination(host, user)) return undefined
  return user ? { host, user } : { host }
}

function validDestination(host: string, user: string | undefined): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) && (user === undefined || /^[A-Za-z0-9._+-]+$/.test(user))
}

export function remoteEditorLink(editorId: EditorId, target: SshTarget, absolutePath: string, kind?: 'file' | 'folder'): string | null {
  if (!REMOTE_EDITOR_IDS.some((id) => id === editorId)) return null
  if (!isAbsoluteHostPath(absolutePath) || isWindowsHostPath(absolutePath) || !validDestination(target.host, target.user)) return null
  const path = absolutePath.replace(/[^/]+/g, encodeURIComponent)
  const destination = target.user ? `${target.user}@${target.host}` : target.host
  if (editorId === 'zed') {
    const authority = target.user ? `${encodeURIComponent(target.user)}@${target.host}` : target.host
    return `zed://ssh/${authority}${path}${kind === 'file' ? ':1:1' : ''}`
  }
  const suffix = kind === 'file' ? ':1:1' : kind === 'folder' ? '?windowId=_blank' : ''
  return `${editorId}://vscode-remote/ssh-remote+${encodeURIComponent(destination)}${path}${suffix}`
}
