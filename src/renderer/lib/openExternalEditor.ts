import type { EditorId, IpcContext, TerminalAppId } from "../../shared/types";
import type { HostApi } from "@client-core/host-api";
import { hostPolicy } from "@client-core/host-policy";
import { serverConnections } from "@client-core/server-connections";
import { supportsEditor } from "@client-core/host-capabilities";
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
    terminalId?: TerminalAppId | null;
  },
): boolean {
  if (!hostPolicy.isClientMachine(opts.serverId)) return false;
  if (!connectionsStore.desktopHandlersAvailable) return false;
  if (!opts.editorId || opts.filePaths.length === 0) return false;
  if (!opts.serverId || !supportsEditor(serverConnections.cachedCapabilitiesFor(opts.serverId), opts.editorId)) return false;
  const cwd = opts.cwd || undefined;
  void opts.api.openInEditor(ctx, {
    filePaths: toAbsoluteFilePaths(opts.filePaths, cwd),
    editorId: opts.editorId,
    terminalId: opts.terminalId ?? undefined,
    cwd,
  });
  return true;
}
