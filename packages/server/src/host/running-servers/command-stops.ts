import type { ProcessFacts } from './processes'

type StopWatcher = (commandId: string) => (() => void) | undefined
const watchers = new Set<StopWatcher>()

/** Codex names each tool command with CODEX_TOOL_CALL_ID. No command text matching. */
export function watchCommandStops(watcher: StopWatcher): () => void {
  watchers.add(watcher)
  return () => { watchers.delete(watcher) }
}

export function notifyCommandStop(members: readonly ProcessFacts[], table: Map<number, ProcessFacts>): () => void {
  const leader = members.find((member) => member.pid === member.groupId)
  const parent = leader ? table.get(leader.parentPid) : undefined
  // A detached child inherits the command id. Stopping that child does not end the tool.
  if (!leader?.commandId || !leader.tagsRead || !parent?.tagsRead || parent.commandId === leader.commandId) return () => {}
  const rollbacks: (() => void)[] = []
  for (const watcher of watchers) {
    const rollback = watcher(leader.commandId)
    if (rollback) rollbacks.push(rollback)
  }
  return () => { for (const rollback of rollbacks) rollback() }
}
