import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SshClient, type SshTarget } from '@solus/server/platform/ssh'
import { spawnHelper, type HelperProcess } from '@solus/server/devices/device-helpers'
import type { DeviceCommandOptions, DeviceCommandRunner } from '@solus/server/devices/device-process'

/**
 * SshClient is the one owner of `ssh` (docs/plans/host-routes.md D8). It
 * stops only the processes it started, sends scripts as data, and never lets
 * ssh prompt unless Solus holds the secret to answer.
 */

const TARGET: SshTarget = { destination: 'me@studio.local', port: 2222 }

function fakeProcess(pid: number) {
  let exit: (code: number | null) => void = () => {}
  const process: HelperProcess & { killed: boolean; exit: (code: number) => void } = {
    pid,
    killed: false,
    exited: new Promise((resolve) => { exit = resolve }),
    kill: () => { process.killed = true; exit(null) },
    exit: (code) => exit(code),
  }
  return process
}

function recordingRunner() {
  const calls: { args: string[]; options: DeviceCommandOptions | undefined; askpass: string | null }[] = []
  const run: DeviceCommandRunner = async (_command, args, options) => {
    const helper = options?.env?.SSH_ASKPASS
    // Read the helper while ssh would run: it must exist then, and print the secret.
    const askpass = helper && existsSync(helper) ? readFileSync(helper, 'utf8') : null
    calls.push({ args: [...args], options, askpass })
    return { code: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('SshClient', () => {
  test.skipIf(process.platform === 'win32')('close stops the captured forward process and no other', async () => {
    // WHY: another Solus session or the developer's own ssh may match the same command line.
    const bystander = spawnHelper('sleep', ['30'], process.env)
    const client = new SshClient({
      run: recordingRunner().run,
      spawn: (_command, _args, env) => spawnHelper('sleep', ['30'], env),
      reservePort: async () => 52000,
    })
    try {
      const forward = await client.forward(TARGET, 41000)
      expect(alive(bystander.pid)).toBe(true)
      forward.close()
      await forward.exited
      expect(alive(bystander.pid)).toBe(true)
    } finally {
      bystander.kill()
      await bystander.exited
    }
  })

  test('exited resolves when the forward process ends, and the forward keeps host-key checks', async () => {
    const child = fakeProcess(7)
    const spawned: string[][] = []
    const client = new SshClient({ run: recordingRunner().run, spawn: (_command, args) => { spawned.push([...args]); return child }, reservePort: async () => 52001 })
    const forward = await client.forward(TARGET, 41000)
    expect(forward.localPort).toBe(52001)
    expect(spawned[0]).toContain('127.0.0.1:52001:127.0.0.1:41000')
    expect(spawned[0]).toContain('ExitOnForwardFailure=yes')
    expect(spawned[0]).toContain('BatchMode=yes')
    expect(spawned[0]!.join(' ')).not.toContain('StrictHostKeyChecking')
    child.exit(255)
    expect(await forward.exited).toBe(255)
    expect(child.killed).toBe(false)
  })

  test('a forward that does not answer is closed and fails', async () => {
    const child = fakeProcess(8)
    const client = new SshClient({
      run: recordingRunner().run,
      spawn: () => child,
      reservePort: async () => 52002,
      fetch: (async () => { child.exit(255); throw new Error('refused') }) as unknown as typeof fetch,
    })
    await expect(client.forward(TARGET, 41000, '/readyz')).rejects.toThrow('did not answer')
    expect(child.killed).toBe(true)
  })

  test.skipIf(process.platform === 'win32')('the script goes on stdin and each argument reaches it as one word', async () => {
    const { calls, run } = recordingRunner()
    const argument = "a b'; touch solus-pwned; echo '$(id)"
    await new SshClient({ run, spawn: () => fakeProcess(1) }).run(TARGET, 'printf "%s\\n" "$1"', [argument])
    const call = calls[0]!
    expect(call.args.slice(-3, -1)).toEqual(['--', 'me@studio.local'])
    expect(call.options?.stdin).toBe('printf "%s\\n" "$1"')
    // The remote command is what sshd gives the remote shell. Run it here with the same stdin.
    const directory = mkdtempSync(join(tmpdir(), 'solus-ssh-client-test-'))
    try {
      writeFileSync(join(directory, 'stdin'), call.options!.stdin!)
      const remote = spawnSync('/bin/sh', ['-c', `${call.args.at(-1)!} < stdin`], { cwd: directory, encoding: 'utf8' })
      expect(remote.stdout).toBe(`${argument}\n`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('without a secret, ssh never prompts; with one, it asks the askpass helper once', async () => {
    const { calls, run } = recordingRunner()
    const client = new SshClient({ run, spawn: () => fakeProcess(1) })

    await client.run(TARGET, 'true', [])
    expect(calls[0]!.args).toContain('BatchMode=yes')
    expect(calls[0]!.options?.env).toBeUndefined()

    await client.run(TARGET, 'true', [], { authSecret: 'passphrase' })
    const withSecret = calls[1]!
    expect(withSecret.args).toContain('BatchMode=no')
    expect(withSecret.args).toContain('NumberOfPasswordPrompts=1')
    expect(withSecret.args.join(' ')).not.toContain('passphrase')
    expect(withSecret.options?.env?.SOLUS_SSH_AUTH_SECRET).toBe('passphrase')
    expect(withSecret.askpass).toContain('SOLUS_SSH_AUTH_SECRET')
    // The helper is removed when the command ends.
    expect(existsSync(withSecret.options!.env!.SSH_ASKPASS!)).toBe(false)
  })

  test('a target that looks like an option is refused before ssh starts', async () => {
    const { calls, run } = recordingRunner()
    await expect(new SshClient({ run, spawn: () => fakeProcess(1) }).run({ destination: '-oProxyCommand=evil' }, 'true', [])).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
