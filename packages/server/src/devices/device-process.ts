import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveHomePath } from '../platform/paths'

/** What a finished command produced. Output is bounded; a timeout reports code 124. */
export interface DeviceCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface DeviceCommandOptions {
  timeoutMs?: number
  stdin?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/**
 * Runs one command to completion. Injected everywhere a device module starts a
 * process, so tests use fake results instead of the machine's simulators.
 * Arguments are an array; nothing here goes through a shell.
 */
export type DeviceCommandRunner = (
  command: string,
  args: readonly string[],
  options?: DeviceCommandOptions,
) => Promise<DeviceCommandResult>

const MAX_OUTPUT_CHARS = 512 * 1024

export const runDeviceCommand: DeviceCommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: DeviceCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(command, [...args], {
      cwd: resolveHomePath(options.cwd ?? homedir()),
      env: options.env ?? process.env,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: 124, stdout, stderr: `${stderr}\ntimed out` })
    }, options.timeoutMs ?? 20_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString()
    })
    child.once('error', (error) => finish({ code: 127, stdout, stderr: error.message }))
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }))
    if (options.stdin !== undefined) child.stdin?.end(options.stdin)
  })

/** The oldest Node the pinned helpers accept (agent-device engines). */
const MIN_NODE: readonly [number, number] = [22, 12]

export function nodeVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

/**
 * A real Node runtime for the helpers. Electron's own binary is not one: the
 * hub loads native addons built for Node's ABI. The PATH copy wins, then the
 * usual install locations, so a GUI-launched app without a login PATH still
 * finds Homebrew's Node.
 */
export async function resolveNodeRuntime(
  env: NodeJS.ProcessEnv,
  run: DeviceCommandRunner,
): Promise<{ nodePath: string; version: string } | { error: string }> {
  const candidates = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  const seen = new Set<string>()
  let found: string | null = null
  for (const candidate of candidates) {
    if (seen.has(candidate) || !existsSync(candidate)) continue
    seen.add(candidate)
    const result = await run(candidate, ['--version'], { timeoutMs: 5_000, env })
    if (result.code !== 0) continue
    const version = result.stdout.trim()
    if (nodeVersionSupported(version)) return { nodePath: candidate, version }
    found ??= version
  }
  return {
    error: found
      ? `Device support needs Node.js 22.12 or newer; found ${found}.`
      : 'Device support needs Node.js 22.12 or newer on this host. Install Node.js and try again.',
  }
}

/** A message safe for clients and logs: first line, bounded, no stack. */
export function boundedDetail(text: string, max = 300): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
