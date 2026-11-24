import type { EditorId, IpcContext, TerminalAppId } from '@solus/contracts/types'
import { isAbsoluteHostPath, trimTrailingSeparators } from '@solus/contracts/host-path'
import type { HostApi } from '@solus/client-core/host-api'
import { hostPolicy } from '@solus/client-core/host-policy'
import { localApi } from '@solus/client-core/local-api'
import { hosts } from '../../../contexts/hosts/hosts.svelte'
import { toAbsoluteFilePaths } from '../../../lib/changedFiles'
import { remoteEditorFileUrl } from '@solus/contracts/local-editor-links'
import { REMOTE_EDITOR_IDS, remoteEditorLink, savedEditorSshTarget, type SshTarget } from '../../../lib/remote-editor-link'
import { toasts } from '../../../lib/toasts'
import { forwardedHostsStore } from '../../connections/forwarded-hosts.store.svelte'

interface EditorOption { id: EditorId; name: string }

export type FileOpenRoute =
  | { kind: 'local'; editors: readonly EditorOption[] }
  | { kind: 'ssh'; target: SshTarget; editors: readonly EditorOption[] }

export type FileOpenAction = 'open' | 'reveal' | { editorId: EditorId }

const DEFAULT_REMOTE_EDITOR: EditorOption = { id: 'vscode', name: 'VS Code' }

function canLaunchRemoteEditor(): boolean {
  if (localApi.getPlatform() !== 'web') return true
  const { userAgent, maxTouchPoints } = navigator
  const isTabletWithDesktopUserAgent = maxTouchPoints > 1 && /Macintosh/.test(userAgent)
  return !isTabletWithDesktopUserAgent && !/Android|iPad|iPhone|iPod/i.test(userAgent)
}

export function fileOpenRoute(serverId: string): FileOpenRoute | null {
  const host = hosts.get(serverId)
  const info = host.serverInfo
  if (info.state !== 'ready' || !host.me.may('host.use') || !host.me.may('host.files.read')) return null
  if (hostPolicy.isClientMachine(serverId)) {
    if (!host.hasDesktopHandlers || !host.me.may('host.local.window')) return null
    const tools = host.tools
    const editors = tools.state === 'ready'
      ? tools.value.editors.filter((editor) => !editor.isTerminal || host.me.may('host.terminal'))
      : []
    return { kind: 'local', editors }
  }
  if (!canLaunchRemoteEditor()) return null

  const device = hosts.device
  const forward = device && forwardedHostsStore.hostsFor(device.id)?.find((entry) =>
    entry.installationId === info.value.installationId && entry.route.source === 'ssh')
  const target = (forward && savedEditorSshTarget(forward.sshTarget)) || info.value.sshTarget
  if (!target) return null
  const tools = device?.tools
  const installed = tools?.state === 'ready'
    ? tools.value.editors.filter((editor) => REMOTE_EDITOR_IDS.some((id) => id === editor.id))
    : []
  return { kind: 'ssh', target, editors: installed.length ? installed : [DEFAULT_REMOTE_EDITOR] }
}

export function fileOpenPath(route: FileOpenRoute, cwd: string, filePath: string): string | null {
  const [path] = toAbsoluteFilePaths([filePath], cwd)
  if (!isAbsoluteHostPath(path)) return null
  const absolutePath = trimTrailingSeparators(path)
  return route.kind === 'local' || remoteEditorLink('vscode', route.target, absolutePath) ? absolutePath : null
}

export async function openFileAction(
  action: FileOpenAction,
  target: { serverId: string; cwd: string; path: string; isFolder?: boolean; api: Pick<HostApi, 'openDesktopFile' | 'openInEditor'>; ctx: IpcContext; fallbackTerminalId?: TerminalAppId },
): Promise<void> {
  // The connection and permissions can change while a menu is open.
  const route = fileOpenRoute(target.serverId)
  if (!route) return
  const path = fileOpenPath(route, target.cwd, target.path)
  if (!path) return
  try {
    let opened: boolean
    if (action === 'open' || action === 'reveal') {
      if (route.kind !== 'local') return
      opened = await target.api.openDesktopFile(path, action)
    } else {
      if (!route.editors.some((editor) => editor.id === action.editorId)) return
      if (route.kind === 'ssh') {
        const link = remoteEditorLink(action.editorId, route.target, path, target.isFolder ? 'folder' : 'file')
        const safeLink = link && remoteEditorFileUrl(link)
        opened = !!safeLink && await localApi.openExternal(safeLink)
      } else {
        opened = await target.api.openInEditor(target.ctx, {
          filePaths: [path],
          editorId: action.editorId,
          cwd: target.cwd,
          fallbackTerminalId: target.fallbackTerminalId,
        })
      }
    }
    if (opened) return
  } catch {
    // The client shell or the host can refuse the action.
  }
  toasts.error(action === 'reveal' ? 'Could not reveal this path' : 'Could not open this path')
}
