import { readFile, readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { RUNNING_SERVER_SESSION_ENV, RUNNING_SERVER_TERMINAL_ENV } from '@solus/contracts/running-servers'
import { runAsync } from '../../git/exec'

export interface ProcessFacts {
  pid: number
  parentPid: number
  groupId: number
  identity: string
  name: string
  sessionId: string | null
  terminalId: string | null
  commandId: string | null
  tagsRead?: boolean
  launchDirectory?: string
  agentOwned?: boolean
  protected: boolean
}

export function isAgentCommand(command: string): boolean {
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const executable = words[0]?.replace(/^["']|["']$/g, '').replaceAll('\\', '/').split('/').at(-1) ?? ''
  if (/^(?:codex|claude|solus|electron)(?:\.exe|\.js)?$/i.test(executable)) return true
  if (!/^(?:node|bun)(?:\.exe)?$/i.test(executable)) return false
  const script = words.slice(1).find((word) => !word.startsWith('-'))?.replace(/^["']|["']$/g, '').replaceAll('\\', '/') ?? ''
  return /\/(?:@anthropic-ai\/claude-code|@openai\/codex|node_modules\/claude)\/(?:.*\/)?(?:cli|codex|claude)(?:\.m?js)?$/i.test(script)
}

function isInteractiveShell(command: string): boolean {
  return /^(?:\S*[/\\])?(?:ba|z|fi|da|k)?sh(?:\s|$)/.test(command) && !/(?:^|\s)-[a-z]*c(?:\s|$)/.test(command)
}

export function parseProcessFacts(output: string, protectedPids: readonly number[] = [process.pid, process.ppid]): Map<number, ProcessFacts> {
  const facts = new Map<number, ProcessFacts>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    facts.set(pid, { pid, parentPid: Number(match[2]), groupId: Number(match[3]), identity: match[4].trim(), name: basename(match[5].split(/\s+/)[0]), sessionId: null, terminalId: null, commandId: null, protected: protectedPids.includes(pid) || isAgentCommand(match[5]) || isInteractiveShell(match[5]) || Number(match[2]) === process.pid })
  }
  // An ancestor of the host is never a stop target, even through a shell.
  let ancestor = process.pid
  const seen = new Set<number>()
  while (facts.has(ancestor) && !seen.has(ancestor)) {
    seen.add(ancestor)
    const fact = facts.get(ancestor)!
    fact.protected = true
    ancestor = fact.parentPid
  }
  return facts
}

const windowsProcessSchema = z.object({ ProcessId: z.number(), ParentProcessId: z.number(), CreationDate: z.string().nullable(), Name: z.string(), CommandLine: z.string().nullable() })
export function parseWindowsProcesses(output: string): Map<number, ProcessFacts> {
  const rows = z.union([z.array(windowsProcessSchema), windowsProcessSchema]).parse(JSON.parse(output))
  const facts = new Map<number, ProcessFacts>()
  const agents = new Set<number>()
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const command = row.CommandLine ?? row.Name
    if (isAgentCommand(command) && /(?:codex|claude)/i.test(row.Name + ' ' + command)) agents.add(row.ProcessId)
    // The terminal launch command carries these two non-secret attribution tags.
    const sessionId = /SOLUS_SESSION_ID\s*=\s*['"]([\w-]+)['"]/.exec(command)?.[1] ?? null
    const terminalId = /SOLUS_TERMINAL_ID\s*=\s*['"]([\w-]+)['"]/.exec(command)?.[1] ?? null
    const launchDirectory = /SOLUS_TERMINAL_CWD\s*=\s*'((?:[^']|'')*)'/.exec(command)?.[1].replace(/''/g, "'")
    facts.set(row.ProcessId, { pid: row.ProcessId, parentPid: row.ParentProcessId, groupId: 0, identity: row.CreationDate ?? '', name: row.Name, sessionId, terminalId, commandId: null, launchDirectory, protected: [process.pid, process.ppid].includes(row.ProcessId) || row.ParentProcessId === process.pid || isAgentCommand(command) })
  }
  attributeWindowsAgents(facts, agents)
  return facts
}

function attributeWindowsAgents(facts: Map<number, ProcessFacts>, agents: Set<number>): void {
  for (const fact of facts.values()) {
    let parentPid = fact.parentPid
    let hasAgentAncestor = false
    const seen = new Set([fact.pid])
    while (parentPid && !seen.has(parentPid)) {
      seen.add(parentPid)
      if (parentPid === process.pid) { fact.agentOwned = hasAgentAncestor; break }
      if (agents.has(parentPid)) hasAgentAncestor = true
      parentPid = facts.get(parentPid)?.parentPid ?? 0
    }
  }
}

/** Commands and environments stay on the host; only attribution tags survive. */
export async function processFacts(): Promise<Map<number, ProcessFacts>> {
  if (process.platform === 'win32') {
    return parseWindowsProcesses(await runAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="CreationDate";e={$_.CreationDate.ToString("o")}},Name,CommandLine | ConvertTo-Json -Compress'], process.cwd(), { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }))
  }
  return parseProcessFacts(await runAsync('ps', ['-Aww', '-o', 'pid=,ppid=,pgid=,lstart=,args='], process.cwd(), { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }))
}

export async function readProcessTags(facts: Map<number, ProcessFacts>, pids: number[]): Promise<void> {
  const tag = (environment: string, separator: string, key: string) => environment.split(separator).find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1) || null
  if (process.platform === 'linux') {
    await Promise.all(pids.map(async (pid) => {
      const fact = facts.get(pid)
      if (!fact) return
      const env = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null)
      if (env === null) return
      fact.tagsRead = true
      fact.sessionId = tag(env, '\0', RUNNING_SERVER_SESSION_ENV)
      fact.terminalId = tag(env, '\0', RUNNING_SERVER_TERMINAL_ENV)
      fact.commandId = tag(env, '\0', 'CODEX_TOOL_CALL_ID')
    }))
  } else if (process.platform === 'darwin' && pids.length) {
    const output = await runAsync('ps', ['-Eww', '-p', pids.join(','), '-o', 'pid=,command='], process.cwd(), { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }).catch(() => '')
    for (const line of output.split('\n')) {
      const fact = facts.get(Number(/^\s*(\d+)/.exec(line)?.[1]))
      if (!fact) continue
      fact.tagsRead = true
      fact.sessionId = new RegExp(`(?:^|\\s)${RUNNING_SERVER_SESSION_ENV}=([^\\s]+)`).exec(line)?.[1] ?? null
      fact.terminalId = new RegExp(`(?:^|\\s)${RUNNING_SERVER_TERMINAL_ENV}=([^\\s]+)`).exec(line)?.[1] ?? null
      fact.commandId = /(?:^|\s)CODEX_TOOL_CALL_ID=([^\s]+)/.exec(line)?.[1] ?? null
    }
  }
  inheritProcessTags(facts, pids)
}

function inheritProcessTags(facts: Map<number, ProcessFacts>, pids: number[]): void {
  // A child of a tagged terminal is owned even if its environment was cleared.
  for (const pid of pids) {
    const fact = facts.get(pid)
    if (!fact || fact.sessionId || fact.terminalId) continue
    const seen = new Set<number>([pid])
    let parent = facts.get(fact.parentPid)
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid)
      if (parent.sessionId || parent.terminalId) { fact.sessionId = parent.sessionId; fact.terminalId = parent.terminalId; fact.launchDirectory = parent.launchDirectory; break }
      parent = facts.get(parent.parentPid)
    }
  }
}

export async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const directories = new Map<number, string>()
  if (process.platform === 'linux') {
    await Promise.all(pids.map(async (pid) => { const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null); if (cwd) directories.set(pid, cwd) }))
  } else if (process.platform !== 'win32' && pids.length) {
    const output = await runAsync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], process.cwd(), { timeout: 5000 }).catch(() => '')
    let pid = 0
    for (const line of output.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1))
      if (line[0] === 'n' && pid) directories.set(pid, line.slice(1))
    }
  }
  return directories
}
