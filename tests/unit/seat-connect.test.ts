import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'

// The connector reaches setup-handlers, which opens the host database module; bun has no node:sqlite.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let SeatConnector: typeof import('@solus/server/seats/seat-connect')['SeatConnector']
let SeatManager: typeof import('@solus/server/seats/seat-manager')['SeatManager']
type SeatManager = InstanceType<typeof SeatManager>

beforeAll(async () => {
  ;({ SeatConnector } = await import('@solus/server/seats/seat-connect'))
  ;({ SeatManager } = await import('@solus/server/seats/seat-manager'))
})

// Step 2 plan §3.6: the provider's own login runs on the host inside the member's
// seat directory with the browser shimmed; the URL goes out, the code comes in on
// stdin, and only a verified credential makes the seat connected.

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdinWrites: string[] = []
  stdin = { writable: true, write: (chunk: string) => { this.stdinWrites.push(chunk); return true } }
  killed: NodeJS.Signals | null = null
  pid = undefined
  kill(signal: NodeJS.Signals) { this.killed = signal; this.emit('close', null, signal); return true }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness(verified = true) {
  const root = mkdtempSync(join(tmpdir(), 'seat-connect-'))
  roots.push(root)
  const db = new Database(':memory:') as unknown as DatabaseSync
  const seats = new SeatManager({ db, seatsRoot: join(root, 'seats'), hostClaudeDir: join(root, '.claude'), hostCodexHome: join(root, '.codex') })
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string | undefined; child: FakeChild }> = []
  const events: Array<{ state: string; error?: string }> = []
  seats.onChanged((event) => events.push({ state: event.state, error: event.error }))
  const connector = new SeatConnector({
    seats,
    verifyLogin: async () => verified,
    spawnProcess: (command, args, options) => {
      const child = new FakeChild()
      spawned.push({ command, args, env: (options?.env ?? {}) as NodeJS.ProcessEnv, cwd: options?.cwd as string | undefined, child })
      return child as unknown as ChildProcess
    },
  })
  return { seats, connector, spawned, events }
}

describe('SeatConnector', () => {
  test('Claude: the login runs in the seat directory with the shim first on PATH and no host credential; the printed URL comes back needing a code', async () => {
    const { seats, connector, spawned } = harness()
    process.env.ANTHROPIC_API_KEY = 'host-key'
    try {
      const started = connector.start('bob', 'claude-code')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const [spawn] = spawned
      expect(spawn?.command).toBe('claude')
      expect(spawn?.args).toEqual(['auth', 'login'])
      expect(spawn?.env.CLAUDE_CONFIG_DIR).toBe(seats.homeFor('bob', 'claude-code'))
      expect(spawn?.env.PATH?.startsWith(seats.shimBinDir())).toBe(true)
      expect(spawn?.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect((await seats.status('bob', 'claude-code')).state).toBe('connecting')
      spawn!.child.stdout.emit('data', 'Browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true\nPaste code here if prompted > ')
      const result = await started
      expect(result).toEqual({ verificationUrl: 'https://claude.ai/oauth/authorize?code=true', requiresCodeInput: true })
      connector.submitCode('bob', 'claude-code', ' abc-123 ')
      expect(spawn!.child.stdinWrites).toEqual(['abc-123\n'])
      spawn!.child.emit('close', 0, null)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await seats.status('bob', 'claude-code')).toMatchObject({ state: 'connected', method: 'login' })
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  test('Codex: the device flow answers with URL and code; a clean exit with no credential is a failure, not a seat', async () => {
    const { seats, connector, spawned, events } = harness(false)
    const started = connector.start('bob', 'codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [spawn] = spawned
    expect(spawn?.args).toEqual(['login', '--device-auth'])
    expect(spawn?.env.CODEX_HOME).toBe(seats.homeFor('bob', 'codex'))
    spawn!.child.stdout.emit('data', 'Open https://auth.openai.com/codex/device\nEnter code: ABCD-EFGH\n')
    const result = await started
    expect(result).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', requiresCodeInput: false })
    spawn!.child.emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await seats.status('bob', 'codex')).state).toBe('none')
    // The reason rides the event to the member's client; a seat that never was has no row to keep it on.
    expect(events.at(-1)).toMatchObject({ state: 'none', error: expect.stringMatching(/no credential was saved/) })
  })

  test('the host login signs in on the CLI\'s defaults: no seat variable, and the probe runs against the defaults too', async () => {
    const { connector, spawned } = harness()
    const probed: Array<string | null> = []
    const owner = new SeatConnector({
      seats: (connector as unknown as { deps: { seats: SeatManager } }).deps.seats,
      verifyLogin: async (_provider, home) => { probed.push(home); return true },
      spawnProcess: (command, args, options) => {
        const child = new FakeChild()
        spawned.push({ command, args, env: (options?.env ?? {}) as NodeJS.ProcessEnv, cwd: options?.cwd as string | undefined, child })
        return child as unknown as ChildProcess
      },
    })
    const started = owner.start('host-owner', 'claude-code')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [spawn] = spawned
    expect(spawn?.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(spawn?.env.PATH?.includes('/bin')).toBe(true)
    spawn!.child.stdout.emit('data', 'Browser didn\'t open, visit: https://claude.ai/oauth/authorize\n')
    await started
    spawn!.child.emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probed).toEqual([null])
  })

  test('a non-zero exit before any URL rejects the start and leaves no seat; cancel ends the process', async () => {
    const { seats, connector, spawned } = harness()
    const started = connector.start('bob', 'codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    spawned[0]!.child.stdout.emit('data', 'network is down\n')
    spawned[0]!.child.emit('close', 1, null)
    await expect(started).rejects.toThrow(/exited with code 1/)
    expect((await seats.status('bob', 'codex')).state).toBe('none')

    const second = connector.start('bob', 'codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await connector.cancel('bob', 'codex')).toBe(true)
    expect(spawned[1]!.child.killed).toBe('SIGTERM')
    await expect(second).rejects.toThrow(/cancelled/)
    expect(() => connector.submitCode('bob', 'codex', 'x')).toThrow(/not waiting/)
  })
})
