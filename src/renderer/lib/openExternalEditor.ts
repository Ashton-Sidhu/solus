import type { EditorId, IpcContext, TerminalAppId } from "../../shared/types";
import { connectionsStore } from "../contexts/connections.store.svelte";
import { toAbsoluteFilePaths } from "./changedFiles";

export function openInConfiguredEditor(
  ctx: IpcContext,
  opts: {
    filePaths: readonly string[];
    cwd?: string | null;
    editorId: EditorId | null;
    terminalId?: TerminalAppId | null;
  },
): boolean {
  if (!connectionsStore.desktopHandlersAvailable) return false;
  if (!opts.editorId || opts.filePaths.length === 0) return false;
  const cwd = opts.cwd || undefined;
  void window.solus.openInEditor(ctx, {
    filePaths: toAbsoluteFilePaths(opts.filePaths, cwd),
    editorId: opts.editorId,
    terminalId: opts.terminalId ?? undefined,
    cwd,
  });
  return true;
}
