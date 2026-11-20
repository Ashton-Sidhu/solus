import type { RunningServer, StopRunningServerResult } from '@solus/contracts/running-servers'
import { runAsync } from '../../git/exec'
import { processFacts, readProcessTags, type ProcessFacts } from './processes'

export interface JobStopDeps {
  processes: () => Promise<Map<number, ProcessFacts>>
  poll?: () => Promise<Map<number, ProcessFacts>>
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => Promise<void>
  wait: () => Promise<void>
  beforeStop: (server: RunningServer, members: readonly ProcessFacts[], table: Map<number, ProcessFacts>) => (() => void) | void
}

export function isolatedJob(facts: Map<number, ProcessFacts>, pid: number): ProcessFacts[] | null {
  const target = facts.get(pid)
  if (!target || target.protected || !target.groupId) return null
  const members = [...facts.values()].filter((fact) => fact.groupId === target.groupId)
  if (!members.length || members.some((fact) => fact.protected || (fact.sessionId && fact.sessionId !== target.sessionId) || (fact.terminalId && fact.terminalId !== target.terminalId))) return null
  // A group with no leader cannot be checked against a recycled group id.
  if (!members.some((fact) => fact.pid === target.groupId)) return null
  return members
}

/** Stop only an isolated, revalidated job. Success means every captured member exited. */
export async function stopJob(server: RunningServer, expectedIdentity: string, deps: JobStopDeps): Promise<StopRunningServerResult> {
  const facts = await deps.processes()
  const target = facts.get(server.process.pid)
  if (!target) return { status: 'already-exited' }
  if (target.identity !== expectedIdentity) return { status: 'refused', reason: 'identity-changed' }
  const members = isolatedJob(facts, target.pid)
  if (!members) return { status: 'refused', reason: 'shared-group' }
  const captured = new Map(members.map((fact) => [fact.pid, fact.identity]))
  const current = await deps.processes()
  const checked = isolatedJob(current, target.pid)
  if (!checked || checked.length !== members.length || checked.some((fact) => captured.get(fact.pid) !== fact.identity)) return { status: 'refused', reason: 'identity-changed' }
  const abandon = deps.beforeStop(server, members, current)
  try { await deps.signal(-target.groupId, 'SIGTERM') } catch (error) {
    abandon?.()
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const table = await (deps.poll ?? deps.processes)()
    const remaining = [...table.values()].filter((fact) => fact.groupId === target.groupId)
    if (!remaining.length) return { status: 'stopped' }
    // Do not signal a new member or a reused PID during escalation.
    if (remaining.some((fact) => captured.get(fact.pid) !== fact.identity || fact.protected)) return { status: 'refused', reason: 'identity-changed' }
    if (attempt === 39) await deps.signal(-target.groupId, 'SIGKILL')
    await deps.wait()
  }
  return { status: 'refused', reason: 'still-running' }
}

export async function readJobProcesses(): Promise<Map<number, ProcessFacts>> {
  const facts = await processFacts()
  await readProcessTags(facts, [...facts.keys()])
  return facts
}

export function defaultJobStop(server: RunningServer, expectedIdentity: string, beforeStop: JobStopDeps['beforeStop'] = () => {}): Promise<StopRunningServerResult> {
  // Windows has no POSIX job group. Do not present a PID-only stop as a safe tree stop.
  if (process.platform === 'win32') return stopWindowsJob(server, expectedIdentity, beforeStop)
  return stopJob(server, expectedIdentity, {
    processes: readJobProcesses, poll: processFacts,
    signal: async (pid, signal) => { process.kill(pid, signal) },
    wait: () => new Promise((resolve) => setTimeout(resolve, 50)), beforeStop,
  })
}

async function stopWindowsJob(server: RunningServer, expectedIdentity: string, beforeStop: JobStopDeps['beforeStop']): Promise<StopRunningServerResult> {
  const facts = await readJobProcesses()
  const target = facts.get(server.process.pid)
  if (!target) return { status: 'already-exited' }
  if (target.identity !== expectedIdentity) return { status: 'refused', reason: 'identity-changed' }
  const descendants = new Set([target.pid])
  let size = 0
  while (size !== descendants.size) {
    size = descendants.size
    for (const fact of facts.values()) if (descendants.has(fact.parentPid)) descendants.add(fact.pid)
  }
  const members = [...facts.values()].filter((fact) => descendants.has(fact.pid))
  if (members.some((fact) => fact.protected)) return { status: 'refused', reason: 'not-permitted' }
  const current = await processFacts()
  if (members.some((fact) => current.get(fact.pid)?.identity !== fact.identity)) return { status: 'refused', reason: 'identity-changed' }
  beforeStop(server, members, current)
  await runAsync('taskkill.exe', ['/PID', String(target.pid), '/T'], process.cwd(), { timeout: 3000 }).catch(() => '')
  for (const force of [false, true]) {
    const remaining = await processFacts()
    const live = members.filter((fact) => remaining.get(fact.pid)?.identity === fact.identity)
    if (!live.length) return { status: 'stopped' }
    if (force) return { status: 'refused', reason: 'still-running' }
    // Force only verified original members, never a new descendant of a reused parent.
    for (const fact of live) await runAsync('taskkill.exe', ['/PID', String(fact.pid), '/F'], process.cwd(), { timeout: 3000 }).catch(() => '')
  }
  return { status: 'refused', reason: 'still-running' }
}
