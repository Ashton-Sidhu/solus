import type { EditorId, IpcContext, TerminalAppId } from '@solus/contracts/types'
import { hostPathBaseName, isAbsoluteHostPath, trimTrailingSeparators } from '@solus/contracts/host-path'
import type { HostApi } from '@solus/client-core/host-api'
import type { LocalFileCopyAction } from '@solus/contracts/local-file-copy'
import { hostPolicy } from '@solus/client-core/host-policy'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { hosts } from '../../../contexts/hosts/hosts.svelte'
import { toAbsoluteFilePaths } from '../../../lib/changedFiles'
import { remoteEditorFileUrl } from '@solus/contracts/local-editor-links'
import { REMOTE_EDITOR_IDS, remoteEditorLink, savedEditorSshTarget, type SshTarget } from '../../../lib/remote-editor-link'
import { toasts } from '../../../lib/toasts'
import { downloadSignedFile } from '../../../lib/signed-file-download'
import { forwardedHostsStore } from '../../connections/forwarded-hosts.store.svelte'

interface EditorOption { id: EditorId; name: string }

export type FileOpenRoute =
  | { kind: 'local'; editors: readonly EditorOption[] }
  | { kind: 'ssh'; target: SshTarget; editors: readonly EditorOption[]; canCopyFile: boolean }

export type FileOpenAction = LocalFileCopyAction | { editorId: EditorId }

interface FileOpenTarget {
  serverId: string
  cwd: string
  path: string
  isFolder?: boolean
  api: Pick<HostApi, 'openDesktopFile' | 'openInEditor' | 'assetCreateUrl'>
  ctx: IpcContext
  fallbackTerminalId?: TerminalAppId
}

const DEFAULT_REMOTE_EDITOR: EditorOption = { id: 'vscode', name: 'VS Code' }
const COPY_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_DOWNLOADS = 4
let downloading = 0

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
  return {
    kind: 'ssh', target, editors: installed.length ? installed : [DEFAULT_REMOTE_EDITOR],
    canCopyFile: !!localApi.showLocalFileCopy,
  }
}

export function fileOpenEditors(route: FileOpenRoute, path: string): readonly EditorOption[] {
  return route.kind === 'local' || remoteEditorLink('vscode', route.target, path) ? route.editors : []
}

export function fileOpenPath(route: FileOpenRoute, cwd: string, filePath: string, isFolder = false): string | null {
  const [path] = toAbsoluteFilePaths([filePath], cwd)
  if (!isAbsoluteHostPath(path)) return null
  const absolutePath = trimTrailingSeparators(path)
  if (route.kind === 'local' || (route.canCopyFile && !isFolder)) return absolutePath
  return fileOpenEditors(route, absolutePath).length ? absolutePath : null
}

async function showRemoteFileCopy(action: LocalFileCopyAction, target: FileOpenTarget, path: string): Promise<void> {
  if (downloading >= MAX_CONCURRENT_DOWNLOADS) {
    toasts.error('Wait for a local copy to finish downloading.')
    return
  }
  downloading++
  const progress = toasts.progress('Downloading a temporary copy…')
  try {
    const origin = serverConnections.httpOriginFor(target.serverId)
    if (!origin) throw new Error('The file host is disconnected.')
    const name = hostPathBaseName(path)
    const { relativeUrl } = await target.api.assetCreateUrl(target.ctx, { path, name, download: true })
    if (serverConnections.httpOriginFor(target.serverId) !== origin) throw new Error('The file host changed connection. Try again.')
    const data = await downloadSignedFile(relativeUrl, origin, AbortSignal.timeout(COPY_TIMEOUT_MS))
    const outcome = await localApi.showLocalFileCopy(name, data, action)
    if (outcome === 'unsafe') {
      progress.error('This file cannot open safely.', { description: 'Use Reveal local copy to see the temporary file.' })
    } else if (outcome === 'done') {
      progress.success(action === 'open' ? 'Temporary copy opened' : 'Temporary copy revealed')
    } else {
      progress.error('The desktop could not show the temporary copy.')
    }
  } catch (error) {
    progress.error('Could not prepare a local copy', { description: error instanceof Error ? error.message : undefined })
  } finally {
    downloading--
  }
}

export async function openFileAction(action: FileOpenAction, target: FileOpenTarget): Promise<void> {
  // The connection and permissions can change while a menu is open.
  const route = fileOpenRoute(target.serverId)
  if (!route) return
  const path = fileOpenPath(route, target.cwd, target.path, target.isFolder)
  if (!path) return
  try {
    let opened: boolean
    if (action === 'open' || action === 'reveal') {
      if (route.kind === 'ssh') {
        if (route.canCopyFile && !target.isFolder) await showRemoteFileCopy(action, target, path)
        return
      }
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
