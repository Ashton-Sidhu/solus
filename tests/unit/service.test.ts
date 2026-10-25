import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  windowsTaskAction,
  windowsTaskXml,
  WINDOWS_TASK_NAME,
  type ServiceEnv,
  type ServiceExec,
} from '../../apps/cli/src/lib/service'
import { windowsSystemTool } from '../../apps/cli/src/lib/runtime'

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

describe('service on Windows (logon task)', () => {
  // WHY: Windows has no user service manager; a per-user Task Scheduler logon
  // task is the supervisor that starts Solus at sign-in without administrator
  // rights (docs/plans/windows.md §5.9). These tests pin the task definition
  // and the schtasks verbs without touching a real Task Scheduler.
  const options = {
    user: 'DESKTOP\\ada',
    launcher: 'C:\\Users\\ada\\.local\\bin\\solus.cmd',
    systemRoot: 'C:\\Windows',
    dataDir: 'C:\\Users\\ada\\my data',
    runtimeDir: 'C:\\Users\\ada\\AppData\\Local\\solus\\runtime',
    port: '4000',
  }

  test('the task runs the stable launcher hidden, with the custom paths', () => {
    expect(windowsTaskAction(options)).toEqual({
      command: 'C:\\Windows\\System32\\conhost.exe',
      arguments: '--headless "C:\\Windows\\System32\\cmd.exe" /d /s /c "set "SOLUS_SUPERVISOR_RESTARTS=1"&& set "SOLUS_RUNTIME_DIR=C:\\Users\\ada\\AppData\\Local\\solus\\runtime"&& "C:\\Users\\ada\\.local\\bin\\solus.cmd" start --data-dir "C:\\Users\\ada\\my data" --port "4000""',
    })
  })

  test('the task XML is a least-privilege logon task of this user that restarts on failure', () => {
    const xml = windowsTaskXml(options)
    expect(xml).toContain('<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>DESKTOP\\ada</UserId>')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<RestartOnFailure>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('&quot;C:\\Users\\ada\\.local\\bin\\solus.cmd&quot; start')
  })

  test('a value that cmd.exe would expand or split is refused', () => {
    expect(() => windowsTaskAction({ ...options, dataDir: 'C:\\%USERPROFILE%\\x' })).toThrow('cannot use a value')
  })

  describe('lifecycle', () => {
    const originalUser = process.env.USERNAME
    const originalDomain = process.env.USERDOMAIN
    const schtasks = windowsSystemTool('schtasks.exe')
    let home: string
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'solus-service-win-'))
      process.env.USERNAME = 'ada'
      process.env.USERDOMAIN = 'DESKTOP'
    })
    afterEach(() => {
      rmSync(home, { recursive: true, force: true })
      if (originalUser === undefined) delete process.env.USERNAME
      else process.env.USERNAME = originalUser
      if (originalDomain === undefined) delete process.env.USERDOMAIN
      else process.env.USERDOMAIN = originalDomain
    })

    function windowsExec(state: string): { exec: ServiceExec; calls: string[][] } {
      const calls: string[][] = []
      const exec: ServiceExec = (command, args) => {
        calls.push([command, ...args])
        if (command.endsWith('powershell.exe')) {
          if (!state) throw new Error('No MSFT_ScheduledTask objects found')
          return `${state}\r\n`
        }
        if (command.endsWith('whoami.exe')) return '"sidhu\\ashto","S-1-5-21-1-2-3-1001"\r\n'
        return ''
      }
      return { exec, calls }
    }

    test('install registers the task from XML and starts it now', () => {
      const { exec, calls } = windowsExec('Running')
      installService(envFor(home, 'win32', exec))
      const create = calls.find((call) => call[1] === '/create')
      expect(create?.slice(0, 5)).toEqual([schtasks, '/create', '/tn', WINDOWS_TASK_NAME, '/xml'])
      expect(create?.[6]).toBe('/f')
      expect(calls.at(-1)).toEqual([schtasks, '/run', '/tn', WINDOWS_TASK_NAME])
    })

    test('status reads the task state, which Windows does not translate', () => {
      expect(serviceStatus(envFor(home, 'win32', windowsExec('Running').exec))).toMatchObject({ platform: 'win32', installed: true, active: true, enabled: true })
      expect(serviceStatus(envFor(home, 'win32', windowsExec('Disabled').exec))).toMatchObject({ installed: true, active: false, enabled: false })
      expect(serviceStatus(envFor(home, 'win32', windowsExec('').exec))).toEqual({ platform: 'win32', installed: false, active: false, enabled: false, detail: null })
    })

    test('start, stop, restart, and uninstall map to schtasks /run, /end, and /delete', () => {
      const { exec, calls } = windowsExec('Running')
      const env = envFor(home, 'win32', exec)
      startService(env)
      stopService(env)
      restartService(env)
      uninstallService(env)
      const verbs = calls.filter((call) => call[0] === schtasks).map((call) => call[1])
      expect(verbs).toEqual(['/run', '/end', '/end', '/run', '/end', '/delete'])
      expect(calls.at(-1)).toEqual([schtasks, '/delete', '/tn', WINDOWS_TASK_NAME, '/f'])
    })

    test('stop also ends the server the task started, and only when the lock still names it', () => {
      // WHY: `schtasks /end` ends the task's own processes. The server the
      // supervisor started kept the port, so the next start failed. A PID in an
      // old lock may now belong to another program, which must not be ended.
      const dataDir = join(home, 'data')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(join(dataDir, 'server.lock'), JSON.stringify({ pid: 4242, port: 3000, host: '0.0.0.0', startedAt: 1 }))
      const taskkill = (commandLine: string) => {
        const calls: string[][] = []
        const exec: ServiceExec = (command, args) => {
          calls.push([command, ...args])
          return command.endsWith('powershell.exe') ? commandLine : ''
        }
        stopService({ ...envFor(home, 'win32', exec), dataDir })
        return calls.find((call) => call[0].endsWith('taskkill.exe'))
      }
      expect(taskkill(`node.exe libexec\\server\\standalone.js --data-dir ${dataDir}`)).toEqual([expect.stringMatching(/taskkill\.exe$/), '/T', '/F', '/PID', '4242'])
      expect(taskkill('C:\\Program Files\\Other\\other.exe')).toBeUndefined()
    })

    test('uninstall with no task does not call schtasks', () => {
      const { exec, calls } = windowsExec('')
      uninstallService(envFor(home, 'win32', exec))
      expect(calls.some((call) => call[0] === schtasks)).toBe(false)
    })
  })
})
