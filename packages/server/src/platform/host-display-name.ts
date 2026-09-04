import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { hostname } from 'os'

interface HostDisplayNameProbe {
  platform: NodeJS.Platform
  hostname: string
  readFile(path: string): string | null
  run(command: string, args: readonly string[]): string | null
}

function normalizeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function linuxPrettyHostname(machineInfo: string | null): string | null {
  if (!machineInfo) return null
  for (const line of machineInfo.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('PRETTY_HOSTNAME=')) continue
    const rawValue = trimmed.slice('PRETTY_HOSTNAME='.length).trim()
    const value = (
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) ? rawValue.slice(1, -1) : rawValue
    return normalizeLabel(value)
  }
  return null
}

export function resolveHostDisplayName(probe: HostDisplayNameProbe): string {
  if (probe.platform === 'darwin') {
    const computerName = normalizeLabel(probe.run('/usr/sbin/scutil', ['--get', 'ComputerName']))
    if (computerName) return computerName
  }

  if (probe.platform === 'linux') {
    const machineInfoName = linuxPrettyHostname(probe.readFile('/etc/machine-info'))
    if (machineInfoName) return machineInfoName
    const prettyHostname = normalizeLabel(probe.run('hostnamectl', ['--pretty']))
    if (prettyHostname) return prettyHostname
  }

  return normalizeLabel(probe.hostname) ?? 'Solus Server'
}

let cachedHostDisplayName: string | null = null

/** The operating system's friendly machine name, resolved once per server boot. */
export function hostDisplayName(): string {
  if (cachedHostDisplayName) return cachedHostDisplayName
  cachedHostDisplayName = resolveHostDisplayName({
    platform: process.platform,
    hostname: hostname(),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    run: (command, args) => {
      try {
        return execFileSync(command, [...args], {
          encoding: 'utf8',
          timeout: 1_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        return null
      }
    },
  })
  return cachedHostDisplayName
}
