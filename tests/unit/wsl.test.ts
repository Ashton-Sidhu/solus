import { describe, expect, mock, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { bridgeArgs, listWslDistros, machineClient, parseDistroList, runArgs, WslClient, wslDistroOf, wslTarget, type MachineClient } from '@solus/server/remote-machines/wsl'
import type { HelperProcess } from '@solus/server/devices/device-helpers'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'
import type { SshClient } from '@solus/server/platform/ssh'

// A WSL distro added as a machine (docs/plans/windows.md §13.6).

describe('the distro list', () => {
  test('reads the default, the state, and the version of each distro', () => {
    const output = [
      '  NAME            STATE           VERSION',
      '* Ubuntu          Running         2',
      '  docker-desktop  Stopped         2',
      '  Legacy          Stopped         1',
      '',
    ].join('\r\n')
    expect(parseDistroList(output)).toEqual([
      { name: 'Ubuntu', isDefault: true, isRunning: true, version: 2 },
      { name: 'docker-desktop', isDefault: false, isRunning: false, version: 2 },
      { name: 'Legacy', isDefault: false, isRunning: false, version: 1 },
    ])
  })

  test('reads rows by position, so a translated header and UTF-16 NULs do not matter', () => {
    // WHY: without WSL_UTF8, an older wsl.exe writes UTF-16, which arrives with NULs.
    const output = '  NAME      STATUS      VERSION\r\n* Ubuntu    Wird ausgeführt   2\r\n'.split('').join('\0')
    expect(parseDistroList(output)).toEqual([{ name: 'Ubuntu', isDefault: true, isRunning: false, version: 2 }])
  })

  test('says why there is nothing to add', async () => {
    expect(await listWslDistros(async () => ({ code: 0, stdout: '', stderr: '' }), 'darwin')).toEqual({ status: 'unavailable', message: 'WSL runs on Windows hosts only.' })
    const notInstalled: DeviceCommandRunner = async () => ({ code: 1, stdout: "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.", stderr: '' })
    expect(await listWslDistros(notInstalled, 'win32')).toMatchObject({ status: 'unavailable', message: expect.stringContaining('wsl --install') })
    const empty: DeviceCommandRunner = async () => ({ code: 0, stdout: '  NAME  STATE  VERSION\r\n', stderr: '' })
    expect(await listWslDistros(empty, 'win32')).toMatchObject({ status: 'unavailable', message: expect.stringContaining('no distro') })
  })
})

describe('a distro as a target', () => {
  test('is named wsl:<distro>, and SSH targets are not distros', () => {
    expect(wslDistroOf(wslTarget('Ubuntu-24.04'))).toBe('Ubuntu-24.04')
    expect(wslDistroOf({ destination: 'me@box' })).toBeNull()
  })

  test('the router sends a distro to WSL and every other target to SSH', async () => {
    const calls: string[] = []
    const fake = (name: string): MachineClient => ({
      run: async () => { calls.push(name); return { code: 0, stdout: '', stderr: '' } },
      forward: async () => { calls.push(name); throw new Error('unused') },
    })
    // SAFETY: the router calls only `run` and `forward`, which the fake has.
    const router = machineClient(fake('ssh') as unknown as SshClient, fake('wsl'))
    await router.run(wslTarget('Ubuntu'), 'x', [])
    await router.run({ destination: 'me@box' }, 'x', [])
    expect(calls).toEqual(['wsl', 'ssh'])
  })

  test('a step runs in the distro with its script on stdin and each argument quoted', async () => {
    let seen: { args: readonly string[]; stdin?: string } | null = null
    const client = new WslClient({
      run: async (_file, args, options) => { seen = { args, stdin: options?.stdin }; return { code: 0, stdout: '', stderr: '' } },
      spawn: () => { throw new Error('unused') },
    })
    await client.run(wslTarget('Ubuntu'), 'echo hi', ['/home/me/.local/bin/solus', "it's"], { command: 'env SOLUS_VERSION=0.37.0 sh -s --' })
    expect(seen).toEqual({
      args: runArgs('Ubuntu', "env SOLUS_VERSION=0.37.0 sh -s -- '/home/me/.local/bin/solus' 'it'\"'\"'s'"),
      stdin: 'echo hi',
    })
    expect(runArgs('Ubuntu', 'x')).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', 'sh', '-c', 'x'])
  })
})

describe('the forward into a distro', () => {
  test('bridges each connection through the release Node to the server, and holds the distro open', async () => {
    // WHY: WSL stops a distro when no process from Windows runs in it, and a
    // distro may be NATed or mirrored; the bridge works in both.
    const server = createServer((_req, res) => res.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const remotePort = (server.address() as AddressInfo).port
    let keepAliveKilled = false
    const keepAlive: HelperProcess = { pid: 1, exited: new Promise(() => {}), kill: () => { keepAliveKilled = true } }
    const spawned: Array<readonly string[]> = []
    const client = new WslClient({
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      spawn: mock((_file: string, args: readonly string[]) => { spawned.push(args); return keepAlive }),
      // The bridge script of a real forward, run here with this Node instead of in a distro.
      bridge: (args) => {
        const exec = args.indexOf('--exec')
        return spawn(process.execPath, args.slice(exec + 2), { stdio: ['pipe', 'pipe', 'ignore'] })
      },
    })

    const forward = await client.forward(wslTarget('Ubuntu'), remotePort, '/health')
    try {
      expect(spawned).toEqual([['-d', 'Ubuntu', '--exec', 'sleep', 'infinity']])
      expect(await (await fetch(`http://127.0.0.1:${forward.localPort}/`)).text()).toBe('ok')
      expect(bridgeArgs('Ubuntu', remotePort).slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', '.local/share/solus/current/bin/node'])
    } finally {
      forward.close()
      server.close()
    }
    expect(keepAliveKilled).toBe(true)
  })
})

describe('adding a distro', () => {
  type Handler = (args: unknown[], ctx: { deviceId?: string }) => Promise<unknown>
  async function handlers(listed: Awaited<ReturnType<typeof listWslDistros>>) {
    const { registerRemoteMachinesHandlers } = await import('@solus/server/transport/handlers/remote-machines-handlers')
    const registered = new Map<string, Handler>()
    const added: Array<{ label: string; target: unknown }> = []
    const provisioned: unknown[] = []
    const deps = {
      provisioner: {},
      wslProvisioner: {
        add: async (request: { target: unknown }) => {
          provisioned.push(request.target)
          return { status: 'ready', host: { target: request.target, os: 'linux', label: 'DESKTOP-PC', installationId: 'inst-wsl', remotePort: 3000, startedBySolus: true, session: { sessionToken: 'tok', identityKey: 'key' } } }
        },
      },
      listWslDistros: async () => listed,
      forwardedHosts: { add: async (host: { label: string; target: unknown }) => { added.push(host); return { installationId: 'inst-wsl', label: host.label } } },
      ssh: {},
      broadcast: () => {},
    }
    // SAFETY: the fake server keeps each handler; the deps carry what these two handlers call.
    registerRemoteMachinesHandlers({ register: (method: string, handler: Handler) => registered.set(method, handler) } as never, deps as never)
    return { add: registered.get('hostsAddWsl')!, added, provisioned }
  }

  test('installs into the distro, then forwards to it under the distro name', async () => {
    // WHY: a distro takes the computer's name, so "DESKTOP-PC" would read as this computer.
    const { add, added, provisioned } = await handlers({ status: 'ready', distros: [{ name: 'Ubuntu', isDefault: true, isRunning: true, version: 2 }] })
    const result = await add([{ distro: 'Ubuntu', requestId: 'r1' }], { deviceId: 'dev-1' })
    expect(provisioned).toEqual([wslTarget('Ubuntu')])
    expect(added[0]).toMatchObject({ label: 'Ubuntu (WSL)', target: wslTarget('Ubuntu') })
    expect(result).toMatchObject({ status: 'forwarded', sessionToken: 'tok' })
  })

  test('refuses a distro WSL does not list, and says why WSL cannot add one', async () => {
    const ready = await handlers({ status: 'ready', distros: [{ name: 'Ubuntu', isDefault: true, isRunning: true, version: 2 }] })
    await expect(ready.add([{ distro: 'Debian', requestId: 'r2' }], { deviceId: 'dev-1' })).rejects.toThrow('WSL has no distro named Debian.')
    const missing = await handlers({ status: 'unavailable', message: 'WSL is not installed on this computer.' })
    await expect(missing.add([{ distro: 'Ubuntu', requestId: 'r3' }], { deviceId: 'dev-1' })).rejects.toThrow('WSL is not installed')
  })
})
