import type { EditorId, IpcContext, TerminalAppId } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { hostPolicy } from "@solus/client-core/host-policy";
import { serverConnections } from "@solus/client-core/server-connections";
import { supportsEditor } from "@solus/client-core/host-capabilities";
import { connectionsStore } from "../contexts";
import { toAbsoluteFilePaths } from "./changedFiles";

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
  if (!hostPolicy.isClientMachine(opts.serverId)) return false;
  if (!connectionsStore.desktopHandlersAvailable) return false;
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
