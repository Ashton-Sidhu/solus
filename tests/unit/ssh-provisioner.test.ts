import { describe, expect, test } from 'bun:test'
import { outputLines, type DeviceCommandResult } from '@solus/server/devices/device-process'
import type { SshClient, SshRunOptions, SshTarget } from '@solus/server/platform/ssh'
import { installPercent, installPlaceFromEnv, SshProvisioner, type RemoteInstallPlace } from '@solus/server/remote-machines/ssh-provisioner'
import { parseSshTarget, withConfigAlias, type SshConfigEntry } from '@solus/server/remote-machines/ssh-targets'

// WHY: docs/plans/host-routes.md D6. Adding a machine over SSH installs and starts
// Solus only when it is not there, never takes over a server that already runs, gives
// a link code only to the installer or the CLI, works on Windows through PowerShell,
// and keeps a test install away from a live one.

const KEY = 'rwYrck6nBUw4mf9XOsblvbvv90Mz16mQW65CFiARkXM'
const TARGET: SshTarget = { destination: 'ada@box' }

interface Call { script: string | undefined; args: readonly string[]; command: string }

interface Machine {
  windows?: boolean
  installed: boolean
  running: boolean
  authFails?: boolean
  /** An older Solus answers a session with no identity key. */
  oldSession?: boolean
  /** The lines the installer prints as it runs. */
  installOutput?: string[]
}

/** A fake machine: each step's script changes it the way the real step would. */
function fakeSsh(machine: Machine) {
  const calls: Call[] = []
  const ok = (stdout: string): DeviceCommandResult => ({ code: 0, stdout, stderr: '' })
  const ssh = {
    run: async (_target: SshTarget, script: string | undefined, args: readonly string[], options: SshRunOptions = {}) => {
      const command = options.command ?? ''
      calls.push({ script, args, command })
      if (machine.authFails) return { code: 255, stdout: '', stderr: 'ada@box: Permission denied (publickey).' }
      const isPowerShell = command.startsWith('powershell')
      if (machine.windows && !isPowerShell) return { code: 1, stdout: '', stderr: "'sh' is not recognized as an internal or external command," }
      const text = isPowerShell ? Buffer.from(command.split(' ').at(-1) ?? '', 'base64').toString('utf16le') : script ?? ''
      if (text.includes('os=')) {
        const cli = machine.installed ? (machine.windows ? 'C:\\Users\\ada\\.local\\bin\\solus.cmd' : '/home/ada/.local/bin/solus') : ''
        return ok(`os=${machine.windows ? 'Windows' : 'Linux'}\nname=box\ncli=${cli}\nport=${machine.running ? '3000' : ''}\ninstallation=install-box\n`)
      }
      if (text.includes('install.sh') || text.includes('install.ps1') || text.includes(' setup')) {
        for (const line of machine.installOutput ?? []) options.onOutput?.(line)
        machine.installed = true
        machine.running = true
        return ok('Solus server is running.\n')
      }
      if (text.includes('auth session create')) {
        return ok(JSON.stringify(machine.oldSession
          ? { sessionToken: 'token-1', installationId: 'install-box', fingerprint: 'abcd1234' }
          : { sessionToken: 'token-1', installationId: 'install-box', fingerprint: 'abcd1234', identityKey: KEY }) + '\n')
      }
      return ok('')
    },
  } as unknown as SshClient
  return { ssh, calls }
}

/** The text of each step the machine ran: the stdin script on POSIX, the decoded PowerShell on Windows. */
function stepTexts(calls: Call[]): string[] {
  return calls.map((call) => call.command.startsWith('powershell')
    ? Buffer.from(call.command.split(' ').at(-1) ?? '', 'base64').toString('utf16le')
    : `${call.script ?? ''}\n${call.args.join(' ')}`)
}

async function add(machine: Machine, options: { link?: boolean; place?: RemoteInstallPlace } = {}) {
  const { ssh, calls } = fakeSsh(machine)
  const steps: string[] = []
  const percents: string[] = []
  const outcome = await new SshProvisioner(ssh, options.place).add(
    { target: TARGET, deviceLabel: 'Ada’s Mac', link: options.link ? { ticket: 'ticket-1', directoryUrl: 'https://app.solus.sh' } : undefined },
    (step, message, percent) => {
      if (percent === undefined) steps.push(step)
      else percents.push(`${step} ${percent}: ${message}`)
    },
  )
  return { outcome, calls, steps, percents, texts: stepTexts(calls) }
}

describe('adding a machine over SSH', () => {
  test('installs and starts Solus where it is not installed, then makes a session for the forward', async () => {
    const { outcome, steps, texts } = await add({ installed: false, running: false })
    expect(steps).toEqual(['connect', 'check', 'install', 'identity'])
    expect(texts.some((text) => text.includes('install.sh') && text.includes('--setup'))).toBe(true)
    expect(outcome).toEqual({
      status: 'ready',
      host: { target: TARGET, os: 'linux', label: 'box', installationId: 'install-box', remotePort: 3000, startedBySolus: true, session: { sessionToken: 'token-1', identityKey: KEY } },
    })
  })

  test('the install reports its percentage as the installer moves, and no other installer output leaves the host', async () => {
    const { steps, percents, texts } = await add({
      installed: false,
      running: false,
      installOutput: [
        'solus-progress download 0',
        'Downloading Solus 1.2.3 (linux-x64)...',
        'solus-progress download 50',
        'solus-progress download 50',
        'solus-progress download 100',
        'solus-progress unpack',
        'Linking with ticket-1@app.solus.sh',
        'solus-progress setup',
      ],
    }, { link: true })
    expect(steps).toEqual(['connect', 'check', 'install'])
    expect(percents).toEqual([
      'install 5: Installing Solus on box',
      'install 45: Installing Solus on box',
      'install 85: Installing Solus on box',
      'install 92: Installing Solus on box',
    ])
    // The installer prints its progress lines only when the provisioner asks.
    expect(texts.some((text) => text.includes('install.sh') && text.includes('SOLUS_INSTALL_PROGRESS=1 sh -s'))).toBe(true)
  })

  test('a Windows install asks the installer for its progress too', async () => {
    const { texts } = await add({ windows: true, installed: false, running: false }, { link: true })
    expect(texts.some((text) => text.includes('install.ps1') && text.includes("$env:SOLUS_INSTALL_PROGRESS = '1'"))).toBe(true)
  })

  test('the install percentage: the download fills the space before unpacking, and other lines are not progress', () => {
    expect(installPercent('solus-progress download 0')).toBe(5)
    expect(installPercent('solus-progress download 100')).toBe(85)
    expect(installPercent('solus-progress download 250')).toBe(85)
    expect(installPercent('  solus-progress unpack  ')).toBe(85)
    expect(installPercent('solus-progress setup')).toBe(92)
    expect(installPercent('Downloading Solus 1.2.3 (linux-x64)...')).toBeNull()
    expect(installPercent('solus-progress somewhere-else 4')).toBeNull()
  })

  test('uses a server that already runs there and does not take it over', async () => {
    const { outcome, texts } = await add({ installed: true, running: true })
    expect(texts.some((text) => text.includes('install.sh') || /\bsetup\b/.test(text.split('\n').at(-1) ?? ''))).toBe(false)
    expect(outcome.status === 'ready' && outcome.host.startedBySolus).toBe(false)
  })

  test('starts an installed server that does not run, and then owns its service', async () => {
    const { outcome, steps } = await add({ installed: true, running: false })
    expect(steps).toContain('start')
    expect(outcome.status === 'ready' && outcome.host.startedBySolus).toBe(true)
  })

  test('a link gives the code to the installer, and makes no session: the account reaches the host', async () => {
    const { outcome, texts } = await add({ installed: false, running: false }, { link: true })
    expect(texts.some((text) => text.includes('install.sh') && text.includes('--link') && text.includes('ticket-1@app.solus.sh'))).toBe(true)
    expect(texts.some((text) => text.includes('auth session create'))).toBe(false)
    expect(outcome.status === 'ready' && outcome.host.session).toBeUndefined()
  })

  test('a link on a server that already runs links it with the CLI', async () => {
    const { texts } = await add({ installed: true, running: true }, { link: true })
    expect(texts.some((text) => text.includes('connect --no-open') && text.includes('--code ticket-1@app.solus.sh'))).toBe(true)
  })

  test('a Windows machine is reached through PowerShell and installed with install.ps1', async () => {
    const { outcome, texts } = await add({ windows: true, installed: false, running: false }, { link: true })
    expect(texts.some((text) => text.includes('install.ps1') && text.includes("-Link 'ticket-1@app.solus.sh'"))).toBe(true)
    expect(outcome.status === 'ready' && outcome.host.os).toBe('windows')
  })

  test('a release with no Windows installer says so, instead of a bare 404', async () => {
    // WHY: Windows support can be merged before a release carries install.ps1; the person needs the way forward.
    const machine: Machine = { windows: true, installed: false, running: false }
    const { ssh } = fakeSsh(machine)
    const run = ssh.run.bind(ssh)
    ssh.run = (async (target, script, args, options) => {
      const command = options?.command ?? ''
      const text = command.startsWith('powershell') ? Buffer.from(command.split(' ').at(-1) ?? '', 'base64').toString('utf16le') : ''
      if (text.includes('install.ps1')) return { code: 1, stdout: '', stderr: 'The remote server returned an error: (404) Not Found.' }
      return run(target, script, args, options)
    }) as SshClient['run']
    await expect(new SshProvisioner(ssh).add({ target: TARGET, deviceLabel: 'Mac' }, () => {})).rejects.toThrow('The latest Solus release has no Windows installer. Install Solus on box by hand, then add it again.')
  })

  test('a refused key asks the person for a password or passphrase', async () => {
    const { outcome } = await add({ installed: true, running: true, authFails: true })
    expect(outcome).toEqual({ status: 'needs-auth', message: 'ada@box refused the SSH keys this computer offered. Name the machine as in ~/.ssh/config, where its key is set, or add the key to ssh-agent.' })
  })

  test('a Solus too old to prove its identity is refused with what to do', async () => {
    await expect(add({ installed: true, running: true, oldSession: true })).rejects.toThrow('Update Solus there with `solus update`')
  })

  test('a test place reaches every step, so the test install never touches the live one', async () => {
    const place = { dataDir: '/tmp/solus-test/data', port: 3999, runtimeDir: '/tmp/solus-test/runtime', binDir: '/tmp/solus-test/bin' }
    const posix = await add({ installed: false, running: false }, { place })
    expect(posix.calls.every((call) => call.command.startsWith("env SOLUS_DATA_DIR='/tmp/solus-test/data' SOLUS_PORT='3999'"))).toBe(true)
    // Only a `solus` in the test's own bin folder counts, never one on PATH.
    expect(posix.texts[0]).not.toContain('command -v solus')
    const windows = await add({ windows: true, installed: false, running: false }, { place })
    const powerShellSteps = stepTexts(windows.calls.filter((call) => call.command.startsWith('powershell')))
    expect(powerShellSteps.length).toBeGreaterThan(0)
    expect(powerShellSteps.every((text) => text.includes("$env:SOLUS_DATA_DIR = '/tmp/solus-test/data'"))).toBe(true)
  })

  test('a place from the environment is read as JSON, and a bad one is refused', () => {
    expect(installPlaceFromEnv(undefined)).toEqual({})
    expect(installPlaceFromEnv('{"dataDir":"/tmp/x","port":3999}')).toEqual({ dataDir: '/tmp/x', port: 3999 })
    expect(() => installPlaceFromEnv('{"port":"not a port"}')).toThrow()
  })
})

describe('an SSH target', () => {
  test('is a user and a host, with an optional port', () => {
    expect(parseSshTarget('ada@box')).toEqual({ destination: 'ada@box' })
    expect(parseSshTarget('ada@box:2222')).toEqual({ destination: 'ada@box', port: 2222 })
    expect(parseSshTarget('ada@[fe80::1]:2222')).toEqual({ destination: 'ada@[fe80::1]', port: 2222 })
    expect(() => parseSshTarget('  ')).toThrow('SSH target is required.')
  })
})

describe('a target named by its address', () => {
  // WHY: `ssh ashto@10.10.1.10` offers only the default keys, while the alias for that
  // address in ~/.ssh/config names the machine's key. A person who types the address
  // must get the key their SSH config already gives that machine.
  const windows: SshConfigEntry = { hosts: ['solus-windows'], hostname: '10.10.1.10', user: 'ashto' }

  test('uses the one ~/.ssh/config alias for that address, keeping the user', () => {
    expect(withConfigAlias(parseSshTarget('ashto@10.10.1.10'), [windows])).toEqual({ destination: 'ashto@solus-windows' })
    expect(withConfigAlias(parseSshTarget('10.10.1.10'), [windows])).toEqual({ destination: 'solus-windows' })
  })

  test('is left alone when the alias names another user, two aliases name the address, or none does', () => {
    expect(withConfigAlias(parseSshTarget('root@10.10.1.10'), [windows])).toEqual({ destination: 'root@10.10.1.10' })
    expect(withConfigAlias(parseSshTarget('ashto@10.10.1.10'), [windows, { hosts: ['win-2'], hostname: '10.10.1.10' }])).toEqual({ destination: 'ashto@10.10.1.10' })
    expect(withConfigAlias(parseSshTarget('ada@10.0.0.9'), [windows])).toEqual({ destination: 'ada@10.0.0.9' })
  })

  test('an alias the person typed stays as it is', () => {
    expect(withConfigAlias(parseSshTarget('solus-windows'), [windows])).toEqual({ destination: 'solus-windows' })
  })
})

describe('the output of a running command', () => {
  test('arrives as lines, across chunks, and a progress bar that redraws with a carriage return reports each redraw', () => {
    const lines: string[] = []
    const write = outputLines((line) => lines.push(line))
    write('Downloading Solus 1.2')
    write('.3...\n###   10%\r######   40%\rdone\r\n')
    write('tail without a newline')
    expect(lines).toEqual(['Downloading Solus 1.2.3...', '###   10%', '######   40%', 'done'])
  })
})
