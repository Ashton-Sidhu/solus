import { spawn } from 'child_process'
import { once } from 'events'
import { existsSync, readFileSync } from 'fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir, userInfo } from 'os'
import { join } from 'path'
import type { DiscoveredServer, SshBootstrapCredential, SshBootstrapResult, SshTargetCandidate } from '../../shared/types'

const SSH_CONNECT_TIMEOUT_SECONDS = 10
const MAX_AUTH_PROMPTS = 2

const ASKPASS_SCRIPT = `#!/bin/sh
if [ "\${SOLUS_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\\n" "$SOLUS_SSH_AUTH_SECRET"
  exit 0
fi
printf 'Solus ssh-askpass invoked without SOLUS_SSH_AUTH_SECRET.\\n' >&2
exit 1
`

const REMOTE_CREDENTIAL_SCRIPT = `set -eu
DEVICE_LABEL="$1"
if command -v solus >/dev/null 2>&1; then
  exec solus auth session create --json --device-label "$DEVICE_LABEL"
fi
if command -v solus-server >/dev/null 2>&1; then
  exec solus-server auth session create --json --device-label "$DEVICE_LABEL"
fi
printf 'Solus CLI not found on PATH. Install the Solus server package or add solus/solus-server to PATH.\\n' >&2
exit 127
`

export interface BootstrapDiscoveredServerInput {
  server: DiscoveredServer
  sshTarget?: string
  authSecret?: string
  attempt?: number
  deviceLabel?: string
}

export interface SshRunOptions {
  target: ParsedSshTarget
  batchMode: boolean
  authSecret?: string
  deviceLabel: string
}

export interface SshRunResult {
  stdout: string
  stderr: string
  code: number
}

export async function bootstrapDiscoveredServerOverSsh(
  input: BootstrapDiscoveredServerInput,
  runSsh: (options: SshRunOptions) => Promise<SshRunResult> = runSshCredentialCommand,
): Promise<SshBootstrapResult> {
  const resolved = resolveSshBootstrapTarget(input.server, input.sshTarget)
  if (resolved.status === 'needs-target') return resolved

  const attempt = Math.max(0, input.attempt ?? 0)
  const hasSecret = typeof input.authSecret === 'string' && input.authSecret.length > 0
  const result = await runSsh({
    target: resolved.target,
    batchMode: !hasSecret,
    ...(hasSecret ? { authSecret: input.authSecret } : {}),
    deviceLabel: (input.deviceLabel ?? 'Solus desktop').slice(0, 64),
  })

  if (result.code !== 0) {
    if (isSshAuthFailure(`${result.stderr}\n${result.stdout}`) && attempt < MAX_AUTH_PROMPTS) {
      return {
        status: 'needs-auth',
        sshTarget: formatSshTarget(resolved.target),
        attempt: attempt + 1,
        message: `SSH authentication failed for ${formatSshTarget(resolved.target)}.`,
      }
    }
    throw new Error(commandFailureMessage(result))
  }

  const line = lastNonEmptyLine(result.stdout)
  if (!line) throw new Error('SSH bootstrap did not return a credential.')
  const credential = JSON.parse(line) as Partial<SshBootstrapCredential>
  if (
    typeof credential.sessionToken !== 'string' ||
    typeof credential.installationId !== 'string' ||
    typeof credential.fingerprint !== 'string'
  ) {
    throw new Error('SSH bootstrap returned an incomplete credential.')
  }
  return { status: 'connected', credential: credential as SshBootstrapCredential }
}

export type ResolveSshBootstrapTargetResult =
  | { status: 'ready'; target: ParsedSshTarget }
  | { status: 'needs-target'; candidates: SshTargetCandidate[]; defaultTarget: string; message: string }

export function resolveSshBootstrapTarget(
  server: DiscoveredServer,
  explicitTarget?: string,
): ResolveSshBootstrapTargetResult {
  if (explicitTarget?.trim()) return { status: 'ready', target: parseSshTarget(explicitTarget) }

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

export interface ParsedSshTarget {
  destination: string
  port?: number
}

export function parseSshTarget(input: string): ParsedSshTarget {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('SSH target is required.')
  const bracketMatch = trimmed.match(/^(.+@\[[^\]]+\]|\[[^\]]+\])(?::(\d+))?$/)
  if (bracketMatch) {
    return {
      destination: bracketMatch[1],
      ...(bracketMatch[2] ? { port: parseSshPort(bracketMatch[2]) } : {}),
    }
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

export function formatSshTarget(target: ParsedSshTarget): string {
  return target.port ? `${target.destination}:${target.port}` : target.destination
}

export function isSshAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(normalized) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  )
}

export async function runSshCredentialCommand(options: SshRunOptions): Promise<SshRunResult> {
  const askpass = options.authSecret ? await createAskpassHelper() : null
  try {
    const args = [
      '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
      '-o', `BatchMode=${options.batchMode ? 'yes' : 'no'}`,
      '-o', 'NumberOfPasswordPrompts=1',
      ...(options.target.port ? ['-p', String(options.target.port)] : []),
      options.target.destination,
      'sh', '-s', '--', options.deviceLabel,
    ]
    const child = spawn('ssh', args, {
      env: {
        ...process.env,
        ...(askpass
          ? {
              SSH_ASKPASS: askpass.path,
              SSH_ASKPASS_REQUIRE: 'force',
              SOLUS_SSH_AUTH_SECRET: options.authSecret ?? '',
              ...(process.env.DISPLAY ? {} : { DISPLAY: 'solus' }),
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(REMOTE_CREDENTIAL_SCRIPT)
    const exitOrError = Promise.race([
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      once(child, 'error').then(([err]) => {
        throw err
      }),
    ])
    const [stdout, stderr, exit] = await Promise.all([
      streamText(child.stdout),
      streamText(child.stderr),
      exitOrError,
    ])
    const [code] = exit
    return { stdout, stderr, code: code ?? 1 }
  } finally {
    if (askpass) await rm(askpass.directory, { recursive: true, force: true }).catch(() => {})
  }
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

async function createAskpassHelper(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-ssh-askpass-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'ssh-askpass.sh')
  await writeFile(path, ASKPASS_SCRIPT, { mode: 0o700 })
  await chmod(path, 0o700)
  return { directory, path }
}

function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function lastNonEmptyLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1)
  return line ?? null
}

function commandFailureMessage(result: SshRunResult): string {
  return lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout) ?? `SSH bootstrap failed (${result.code}).`
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
