import { existsSync, readFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { join } from 'path'
import type { DiscoveredServer } from '@solus/contracts/types'
import type { SshTargetCandidate } from '@solus/contracts/remote-machines'
import type { SshTarget } from '../platform/ssh'

/**
 * The SSH target a person names for a machine, and the targets this host can
 * suggest for one it discovered: entries in `~/.ssh/config` that name it, then
 * names in `~/.ssh/known_hosts`.
 */

export type SshTargetResolution =
  | { status: 'ready'; target: SshTarget }
  | { status: 'needs-target'; candidates: SshTargetCandidate[]; defaultTarget: string; message: string }

export function resolveSshTarget(
  server: DiscoveredServer | undefined,
  explicitTarget?: string,
): SshTargetResolution {
  if (explicitTarget?.trim()) return { status: 'ready', target: parseSshTarget(explicitTarget) }

  if (!server) throw new Error('SSH target is required.')
  const candidates = sshTargetCandidates(server)
  const configCandidates = candidates.filter((candidate) => candidate.source === 'ssh-config')
  if (configCandidates.length === 1) {
    return { status: 'ready', target: parseSshTarget(configCandidates[0].target) }
  }

  const defaultTarget = `${safeLocalUsername()}@${server.name || server.host}`
  return {
    status: 'needs-target',
    candidates,
    defaultTarget,
    message: `Enter the SSH target for ${server.name || server.host}.`,
  }
}

export function parseSshTarget(input: string): SshTarget {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('SSH target is required.')
  const bracketMatch = trimmed.match(/^(.+@\[[^\]]+\]|\[[^\]]+\])(?::(\d+))?$/)
  if (bracketMatch) {
    const target: SshTarget = { destination: bracketMatch[1] }
    if (bracketMatch[2]) target.port = parseSshPort(bracketMatch[2])
    return target
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > -1 && trimmed.indexOf(':') === colon) {
    const maybePort = trimmed.slice(colon + 1)
    if (/^\d+$/.test(maybePort)) {
      return { destination: trimmed.slice(0, colon), port: parseSshPort(maybePort) }
    }
  }
  return { destination: trimmed }
}

export function formatSshTarget(target: SshTarget): string {
  return target.port ? `${target.destination}:${target.port}` : target.destination
}

export function sshTargetCandidates(server: DiscoveredServer): SshTargetCandidate[] {
  const candidates = new Map<string, SshTargetCandidate>()
  for (const entry of readSshConfigEntries()) {
    if (!sshConfigEntryMatches(entry, server)) continue
    const alias = entry.hosts.find((host) => !hasSshPattern(host)) ?? entry.hosts[0]
    const destination = entry.user ? `${entry.user}@${alias}` : alias
    const target = entry.port ? `${destination}:${entry.port}` : destination
    candidates.set(target, {
      target,
      label: entry.hostname ? `${alias} -> ${entry.hostname}` : alias,
      source: 'ssh-config',
    })
  }
  for (const host of readKnownHosts()) {
    if (host !== server.host && host !== server.name) continue
    const target = `${safeLocalUsername()}@${host}`
    if (!candidates.has(target)) {
      candidates.set(target, { target, label: host, source: 'known-hosts' })
    }
  }
  return [...candidates.values()]
}

interface SshConfigEntry {
  hosts: string[]
  hostname?: string
  user?: string
  port?: number
}

function readSshConfigEntries(): SshConfigEntry[] {
  const file = join(homedir(), '.ssh', 'config')
  if (!existsSync(file)) return []
  const entries: SshConfigEntry[] = []
  let current: SshConfigEntry | null = null
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const [keywordRaw, ...rest] = line.split(/\s+/)
    const keyword = keywordRaw.toLowerCase()
    const value = rest.join(' ')
    if (keyword === 'host') {
      current = { hosts: rest.filter((host) => !host.startsWith('!')) }
      entries.push(current)
      continue
    }
    if (!current) continue
    if (keyword === 'hostname' && value) current.hostname = value
    else if (keyword === 'user' && value) current.user = value
    else if (keyword === 'port' && /^\d+$/.test(value)) current.port = parseSshPort(value)
  }
  return entries
}

function sshConfigEntryMatches(entry: SshConfigEntry, server: DiscoveredServer): boolean {
  const names = new Set([server.host, server.name, `${server.name}.local`].filter(Boolean))
  if (entry.hostname && names.has(entry.hostname)) return true
  return entry.hosts.some((host) => !hasSshPattern(host) && names.has(host))
}

function readKnownHosts(): string[] {
  const file = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(file)) return []
  const hosts = new Set<string>()
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('|')) continue
    const first = rawLine.split(/\s+/)[0]
    for (const host of first.split(',')) {
      if (!host || host.startsWith('[')) continue
      hosts.add(host)
    }
  }
  return [...hosts]
}

function parseSshPort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid SSH port: ${value}`)
  return port
}

function hasSshPattern(value: string): boolean {
  return /[*?]/.test(value)
}

function safeLocalUsername(): string {
  try {
    return userInfo().username || 'user'
  } catch {
    return 'user'
  }
}
