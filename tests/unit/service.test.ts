import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installService,
  linuxUnitContent,
  linuxUnitPath,
  macosPlistContent,
  macosPlistPath,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
  type ServiceEnv,
  type ServiceExec,
} from '../../apps/cli/src/lib/service'

// The native service is the difference between "solus start in a terminal"
// and a host that keeps running. These tests exercise the unit content and
// the start/stop/restart/uninstall command sequence without touching a real
// systemd/launchd, which the VM run covers.

function recordingExec(): { exec: ServiceExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: ServiceExec = (command, args) => {
    calls.push([command, ...args])
    if (command === 'id') return '501\n'
    if (command === 'loginctl' && args[0] === 'show-user') return 'Linger=yes\n'
    if (command === 'systemctl' && args.includes('is-active')) return 'active\n'
    if (command === 'systemctl' && args.includes('is-enabled')) return 'enabled\n'
    if (command === 'launchctl' && args[0] === 'print') return 'state = running\n'
    return ''
  }
  return { exec, calls }
}

function envFor(home: string, platform: NodeJS.Platform, exec: ServiceExec): ServiceEnv {
  return { home, binDir: join(home, '.local', 'bin'), logFile: join(home, '.solus', 'logs', 'solus.log'), platform, exec }
}

describe('service unit content', () => {
  test('the Linux unit always execs the stable launcher, never a version path', () => {
    const content = linuxUnitContent('/home/sidhu/.local/bin')
    expect(content).toContain('ExecStart="/home/sidhu/.local/bin/solus" start')
    expect(content).toContain('Restart=on-failure')
  })

  test('the macOS plist runs at load and keeps the process alive', () => {
    const content = macosPlistContent('/Users/sidhu/.local/bin', '/Users/sidhu/.solus/logs/solus.log')
    expect(content).toContain('<string>/Users/sidhu/.local/bin/solus</string>')
    expect(content).toContain('<key>RunAtLoad</key><true/>')
  })
})

describe('service lifecycle (Linux)', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'solus-service-linux-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  test('install writes the unit, reloads, and enables it now', () => {
    const { exec, calls } = recordingExec()
    const env = envFor(home, 'linux', exec)

    const result = installService(env)

    expect(existsSync(linuxUnitPath(home))).toBe(true)
    expect(readFileSync(linuxUnitPath(home), 'utf8')).toContain('ExecStart=')
    expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload'])
    expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'solus.service'])
    expect(result.lingerAdvice).toBeNull()
  })

  test('install reports how to enable lingering when it cannot enable it itself', () => {
    const exec: ServiceExec = (command, args) => {
      if (command === 'loginctl' && args[0] === 'show-user') throw new Error('no permission')
      if (command === 'loginctl' && args[0] === 'enable-linger') throw new Error('no permission')
      return ''
    }
    const env = envFor(home, 'linux', exec)

    const result = installService(env)
    expect(result.lingerAdvice).toContain('sudo loginctl enable-linger')
  })

  test('status reports installed/active/enabled from systemctl', () => {
    const { exec } = recordingExec()
    const env = envFor(home, 'linux', exec)
    installService(env)

    const status = serviceStatus(env)
    expect(status).toMatchObject({ platform: 'linux', installed: true, active: true, enabled: true, detail: null })
  })

  test('status before install reports not installed without shelling out', () => {
    const calls: string[][] = []
    const exec: ServiceExec = (command, args) => { calls.push([command, ...args]); return '' }
    const status = serviceStatus(envFor(home, 'linux', exec))
    expect(status).toEqual({ platform: 'linux', installed: false, active: false, enabled: false, detail: null })
    expect(calls).toEqual([])
  })

  test('start/stop/restart map to the matching systemctl verb', () => {
    const { exec, calls } = recordingExec()
    const env = envFor(home, 'linux', exec)

    startService(env)
    stopService(env)
    restartService(env)

    expect(calls).toContainEqual(['systemctl', '--user', 'start', 'solus.service'])
    expect(calls).toContainEqual(['systemctl', '--user', 'stop', 'solus.service'])
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'solus.service'])
  })

  test('uninstall disables the unit, removes it, and leaves everything else alone', () => {
    const { exec, calls } = recordingExec()
    const env = envFor(home, 'linux', exec)
    installService(env)

    uninstallService(env)

    expect(existsSync(linuxUnitPath(home))).toBe(false)
    expect(calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'solus.service'])
  })

  test('uninstall on a host with no service installed does not shell out', () => {
    const calls: string[][] = []
    const exec: ServiceExec = (command, args) => { calls.push([command, ...args]); return '' }
    uninstallService(envFor(home, 'linux', exec))
    expect(calls).toEqual([])
  })
})

describe('service lifecycle (macOS)', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'solus-service-mac-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  test('install writes the plist and bootstraps it under the user gui domain', () => {
    const { exec, calls } = recordingExec()
    const env = envFor(home, 'darwin', exec)

    installService(env)

    expect(existsSync(macosPlistPath(home))).toBe(true)
    expect(calls.some((call) => call[0] === 'launchctl' && call[1] === 'bootstrap' && call[2] === 'gui/501')).toBe(true)
    expect(calls.some((call) => call[0] === 'launchctl' && call[1] === 'enable')).toBe(true)
  })

  test('status reports the LaunchAgent login/sleep caveat', () => {
    const { exec } = recordingExec()
    const env = envFor(home, 'darwin', exec)
    installService(env)

    const status = serviceStatus(env)
    expect(status.installed).toBe(true)
    expect(status.active).toBe(true)
    expect(status.detail).toContain('logged in')
  })
})


test('service configuration preserves custom data/runtime paths and escapes XML', () => {
  const env = { home: '/tmp/home', binDir: '/tmp/my tools', logFile: '/tmp/log&file', dataDir: '/tmp/my data', runtimeDir: '/tmp/runtime', host: '127.0.0.1', port: '4000', platform: 'linux' as const, exec: () => '' }
  expect(linuxUnitContent(env.binDir, env)).toContain('--data-dir "/tmp/my data"')
  expect(linuxUnitContent(env.binDir, env)).toContain('SOLUS_RUNTIME_DIR=/tmp/runtime')
  expect(linuxUnitContent(env.binDir, env)).toContain('KillMode=mixed')
  expect(macosPlistContent(env.binDir, env.logFile, env)).toContain('log&amp;file')
  expect(macosPlistContent(env.binDir, env.logFile, env)).toContain('<string>/tmp/my data</string>')
})
