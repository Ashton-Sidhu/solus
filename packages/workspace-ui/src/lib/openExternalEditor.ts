import type { EditorId, IpcContext, TerminalAppId } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { hostPolicy } from "@solus/client-core/host-policy";
import { serverConnections } from "@solus/client-core/server-connections";
import { supportsEditor } from "@solus/client-core/host-capabilities";
import { hosts } from "../contexts/hosts/hosts.svelte";
import { toAbsoluteFilePaths } from "./changedFiles";
import { localApi } from "@solus/client-core/local-api";
import { remoteEditorLink } from "./remote-editor-link";

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
  if (!hostPolicy.isClientMachine(opts.serverId)) {
    if (!opts.serverId || !editorId || opts.filePaths.length === 0) return false;
    const info = hosts.get(opts.serverId)?.serverInfo;
    const target = info?.state === 'ready' ? info.value.sshTarget : undefined;
    const paths = toAbsoluteFilePaths(opts.filePaths, opts.cwd || undefined);
    const link = target && paths.length === 1 ? remoteEditorLink(editorId, target, paths[0]) : null;
    if (!link) return false;
    void localApi.openExternal(link);
    return true;
  }
  if (!hosts.device?.hasDesktopHandlers) return false;
  if (!editorId || opts.filePaths.length === 0) return false;
  if (!opts.serverId || !supportsEditor(serverConnections.cachedCapabilitiesFor(opts.serverId), editorId)) return false;
  const cwd = opts.cwd || undefined;
  void opts.api.openInEditor(ctx, {
    filePaths: toAbsoluteFilePaths(opts.filePaths, cwd),
    editorId,
    fallbackTerminalId: opts.fallbackTerminalId ?? undefined,
    cwd,
  });
  return true;
}
