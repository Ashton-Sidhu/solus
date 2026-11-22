import type { EditorId, IpcContext, TerminalAppId } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { hostPolicy } from "@solus/client-core/host-policy";
import { serverConnections } from "@solus/client-core/server-connections";
import { supportsEditor } from "@solus/client-core/host-capabilities";
import { hosts } from "../contexts/hosts/hosts.svelte";
import { toAbsoluteFilePaths } from "./changedFiles";
import { localApi } from "@solus/client-core/local-api";
import { remoteEditorLink } from "./remote-editor-link";

/** Where a file of `serverId` opens: an SSH link in this device's editor, the host's own editor, or nowhere. */
function editorRoute(serverId: string | undefined, editorId: EditorId | null): "remote" | "host" | null {
  if (!serverId || !editorId) return null;
  if (!hostPolicy.isClientMachine(serverId)) {
    const info = hosts.get(serverId)?.serverInfo;
    return info?.state === 'ready' && info.value.sshTarget ? "remote" : null;
  }
  if (!hosts.device?.hasDesktopHandlers) return null;
  return supportsEditor(serverConnections.cachedCapabilitiesFor(serverId), editorId) ? "host" : null;
}

/** Whether this client can open a file of `serverId` in the configured editor, so a surface offers the action only where it works. */
export function canOpenInConfiguredEditor(serverId: string | undefined, editorId: EditorId | null): boolean {
  return editorRoute(serverId, editorId) !== null;
}

export function openInConfiguredEditor(
  ctx: IpcContext,
  opts: {
    api: HostApi;
    serverId?: string;
    filePaths: readonly string[];
    cwd?: string | null;
    editorId: EditorId | null;
    fallbackTerminalId?: TerminalAppId | null;
  },
): boolean {
  const { editorId } = opts;
  const route = editorRoute(opts.serverId, editorId);
  if (!route || !editorId || opts.filePaths.length === 0) return false;
  if (route === "remote") {
    const info = hosts.get(opts.serverId!)?.serverInfo;
    const target = info?.state === 'ready' ? info.value.sshTarget : undefined;
    const paths = toAbsoluteFilePaths(opts.filePaths, opts.cwd || undefined);
    const link = target && paths.length === 1 ? remoteEditorLink(editorId, target, paths[0]) : null;
    if (!link) return false;
    void localApi.openExternal(link);
    return true;
  }
  const cwd = opts.cwd || undefined;
  void opts.api.openInEditor(ctx, {
    filePaths: toAbsoluteFilePaths(opts.filePaths, cwd),
    editorId,
    fallbackTerminalId: opts.fallbackTerminalId ?? undefined,
    cwd,
  });
  return true;
}
