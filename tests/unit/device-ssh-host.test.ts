import { describe, expect, test } from 'bun:test'
import { sshDeviceHostConfigSchema } from '@solus/contracts/device-types'
import { SshDeviceHost, isLocalSshTarget, parseScriptReply, quoteRemoteArg, sshArgs } from '@solus/server/devices/ssh-device-host'
import { REMOTE_COMMAND, sshDeviceScript } from '@solus/server/devices/ssh-device-script'
import type { DeviceCommandOptions, DeviceCommandRunner } from '@solus/server/devices/device-process'
import type { HelperProcess } from '@solus/server/devices/device-helpers'

/**
 * SSH device hosts (P20, P21): the SSH trust model is kept, nothing a user
 * typed becomes shell text, a self-alias is detected without connecting,
 * and a lost tunnel is reported instead of pretending the host is ready.
 */

const CONFIG = sshDeviceHostConfigSchema.parse({ id: 'studio', label: 'Studio Mac', target: 'me@studio.local', port: 2222, identityFile: '~/.ssh/id_ed25519' })

function fakeForward(pid: number) {
  let exit: (code: number | null) => void = () => {}
  const process: HelperProcess & { killed: boolean; exit: () => void } = {
    pid,
    killed: false,
    exited: new Promise((resolve) => { exit = resolve }),
    kill: () => { process.killed = true; exit(0) },
    exit: () => exit(255),
  }
  return process
}

describe('SSH device host', () => {
  test('options keep host-key checks and refuse prompts', () => {
    const args = sshArgs(CONFIG)
    expect(args).toContain('BatchMode=yes')
    expect(args.join(' ')).not.toContain('StrictHostKeyChecking=no')
    expect(args.join(' ')).not.toContain('UserKnownHostsFile=/dev/null')
    expect(args.slice(-2)).toEqual(['--', 'me@studio.local'])
    expect(args).toContain('2222')
  })

  test('a target that looks like an option is refused by the schema', () => {
    expect(sshDeviceHostConfigSchema.safeParse({ id: 'x', label: 'X', target: '-oProxyCommand=evil' }).success).toBe(false)
    expect(sshDeviceHostConfigSchema.safeParse({ id: 'local', label: 'X', target: 'host' }).success).toBe(false)
    expect(sshDeviceHostConfigSchema.safeParse({ id: 'x', label: 'X', target: 'host name' }).success).toBe(false)
  })

  test('remote commands quote every argument, including shell metacharacters', async () => {
    const calls: { args: string[]; options?: DeviceCommandOptions }[] = []
    const run: DeviceCommandRunner = async (_command, args, options) => {
      calls.push({ args: [...args], ...(options ? { options } : {}) })
      return { code: 0, stdout: '', stderr: '' }
    }
    const host = new SshDeviceHost(CONFIG, { run, spawn: () => fakeForward(1) })
    await host.run('xcrun', ['simctl', 'openurl', 'SIM', "x'; rm -rf ~; echo '$(id)"])
    const remote = calls[0]!.args.at(-1)!
    expect(remote).toContain(quoteRemoteArg("x'; rm -rf ~; echo '$(id)"))
    expect(quoteRemoteArg("a'b")).toBe(`'a'"'"'b'`)
  })

  test('the remote program goes over stdin, never as command text', async () => {
    const calls: { args: string[]; stdin?: string }[] = []
    const run: DeviceCommandRunner = async (_command, args, options) => {
      calls.push({ args: [...args], ...(options?.stdin ? { stdin: options.stdin } : {}) })
      return { code: 0, stdout: JSON.stringify({ nodeOk: true, npmOk: true, nodeVersion: '22.14.0', platforms: [{ platform: 'ios', available: true }, { platform: 'android', available: false, reason: 'no adb' }], tools: { hub: { requiredVersion: '0.12.0', installedVersions: [], runningVersion: null }, agent: { requiredVersion: '0.21.12', installedVersions: [], runningVersion: null } } }), stderr: '' }
    }
    const host = new SshDeviceHost(CONFIG, { run, spawn: () => fakeForward(1) })
    const result = await host.test()
    expect(calls[0]!.args.at(-1)).toBe(REMOTE_COMMAND)
    expect(calls[0]!.stdin).toContain('const mode = "probe"')
    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.name === 'android')).toMatchObject({ ok: false, detail: 'no adb' })
  })

  test('the probe script installs nothing', () => {
    // WHY: Test connection must have no install or launch side effect.
    const script = sshDeviceScript('owner', 'probe')
    const probeBranch = script.slice(script.indexOf("if (mode === 'probe')"), script.indexOf('return;', script.indexOf("if (mode === 'probe')")))
    expect(probeBranch).not.toContain('install(')
    expect(probeBranch).not.toContain('spawn(')
  })

  test('an unreachable host fails the test with the SSH reason', async () => {
    const run: DeviceCommandRunner = async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host studio port 2222: Connection refused\n' })
    const result = await new SshDeviceHost(CONFIG, { run, spawn: () => fakeForward(1) }).test()
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toContain('Connection refused')
  })

  test('start forwards the hub port to loopback; a lost tunnel clears readiness', async () => {
    const forward = fakeForward(99)
    const spawned: string[][] = []
    const run: DeviceCommandRunner = async () => ({ code: 0, stdout: JSON.stringify({ nodeOk: true, npmOk: true, platforms: [], hubPort: 41000, nodePath: '/usr/local/bin/node', tools: { hub: { requiredVersion: '0.12.0', installedVersions: ['0.12.0'], runningVersion: null }, agent: { requiredVersion: '0.21.12', installedVersions: [], runningVersion: null } } }), stderr: '' })
    const host = new SshDeviceHost(CONFIG, {
      run,
      spawn: (_command, args) => { spawned.push([...args]); return forward },
      reservePort: async () => 52000,
      fetch: (async () => new Response('ok')) as unknown as typeof fetch,
    })
    const ready = await host.ensureReady(() => {})
    expect(ready.hubOrigin).toBe('http://127.0.0.1:52000')
    expect(spawned[0]).toContain('127.0.0.1:52000:127.0.0.1:41000')
    expect(spawned[0]).toContain('ExitOnForwardFailure=yes')
    forward.exit()
    await forward.exited
    await Promise.resolve()
    expect(host.current()).toBeNull()
  })

  test('stop closes owned tunnels even when the host is unreachable', async () => {
    const forward = fakeForward(5)
    let reachable = true
    const run: DeviceCommandRunner = async () => (reachable
      ? { code: 0, stdout: JSON.stringify({ hubPort: 41000, nodePath: '/n', platforms: [] }), stderr: '' }
      : { code: 255, stdout: '', stderr: 'unreachable' })
    const host = new SshDeviceHost(CONFIG, { run, spawn: () => forward, reservePort: async () => 52001, fetch: (async () => new Response('ok')) as unknown as typeof fetch })
    await host.ensureReady(() => {})
    reachable = false
    await host.stop()
    expect(forward.killed).toBe(true)
    expect(host.current()).toBeNull()
  })

  test('a self-alias is detected from ssh -G without connecting', async () => {
    const run: DeviceCommandRunner = async (_command, args) => {
      expect(args[0]).toBe('-G')
      return { code: 0, stdout: 'user me\nhostname 127.0.0.1\nport 22\n', stderr: '' }
    }
    expect(await isLocalSshTarget(CONFIG, run)).toBe(true)
    const remote: DeviceCommandRunner = async () => ({ code: 0, stdout: 'hostname 203.0.113.9\n', stderr: '' })
    expect(await isLocalSshTarget(CONFIG, remote)).toBe(false)
  })

  test('script replies are read from the last JSON line', () => {
    expect(parseScriptReply('npm notice\n{"hubPort":1}\n')).toEqual({ hubPort: 1 })
    expect(parseScriptReply('nothing')).toBeNull()
  })
})
