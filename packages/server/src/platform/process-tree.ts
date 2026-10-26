import { execFileSync, type ChildProcess } from 'node:child_process'
import { createLogger } from '../logger'

const log = createLogger('ProcessTree', 'process-tree.ts')
const STOP_GRACE_MS = 3_000

/**
 * The process groups of `rootPid` and of every process below it, read from `ps`
 * now. This server's own group is never one of them. An agent CLI runs each shell
 * command in a group of its own, so the root's group alone misses them.
 */
export function descendantGroups(rootPid: number): Set<number> {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
  const groupOf = new Map<number, number>()
  const childrenOf = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (!pid || !pgid) continue
    groupOf.set(pid, pgid)
    const children = childrenOf.get(ppid) ?? []
    children.push(pid)
    childrenOf.set(ppid, children)
  }
  const groups = new Set<number>()
  const pending = [rootPid]
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    const group = groupOf.get(pid)
    if (group) groups.add(group)
    pending.push(...(childrenOf.get(pid) ?? []))
  }
  const ownGroup = groupOf.get(process.pid)
  if (ownGroup !== undefined) groups.delete(ownGroup)
  groups.delete(1)
  return groups
}

function signalGroups(groups: Set<number>, signal: NodeJS.Signals): void {
  for (const group of groups) {
    // ESRCH: the group is already empty. EPERM: it runs as another user.
    try { process.kill(-group, signal) } catch {}
  }
}

/**
 * Ends what a child left running when it exits. Call it while `child` is alive: it
 * records the process groups of the child's tree now, because a leftover is
 * reparented when its parent exits. When the child exits, those groups get
 * SIGTERM, and SIGKILL after a grace. A process that left with `setsid` and a
 * new group after this call is not reached. POSIX only: Windows has no groups.
 */
export function endTreeAfterExit(child: ChildProcess, graceMs = STOP_GRACE_MS): void {
  const pid = child.pid
  if (process.platform === 'win32' || pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  let groups: Set<number>
  try {
    groups = descendantGroups(pid)
  } catch (error) {
    log.warn('process_tree_read_failed', { pid, error: error instanceof Error ? error.message : String(error) })
    return
  }
  child.once('exit', () => {
    signalGroups(groups, 'SIGTERM')
    setTimeout(() => signalGroups(groups, 'SIGKILL'), graceMs).unref()
  })
}
