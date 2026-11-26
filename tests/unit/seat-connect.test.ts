import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { ANTIGRAVITY_SIGN_IN_FILE, antigravitySignedIn, hostAntigravityProfile } from '@solus/server/execution/agents/acp/antigravity-auth'

const BOB: Seat = { kind: 'user', userId: { kind: 'account', accountId: 'bob' } }

// The connector reaches setup-handlers, which opens the host database module; bun has no node:sqlite.
mock.module('node:sqlite', () => ({ DatabaseSync }))

let SeatConnector: typeof import('@solus/server/execution/seats/seat-connect')['SeatConnector']
let SeatManager: typeof import('@solus/server/execution/seats/seat-manager')['SeatManager']
type SeatManager = InstanceType<typeof SeatManager>

beforeAll(async () => {
  ;({ SeatConnector } = await import('@solus/server/execution/seats/seat-connect'))
  ;({ SeatManager } = await import('@solus/server/execution/seats/seat-manager'))
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

function harness(verified = true, onSpawn?: () => void) {
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
      onSpawn?.()
      return child as unknown as ChildProcess
    },
  })
  return { seats, connector, spawned, events }
}

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('SeatConnector', () => {
  test('named instances relay codes and cancellation to their own process without changing the base seat', async () => {
    let spawnedSignal = () => {}
    const { seats, connector, spawned, events } = harness(true, () => spawnedSignal())
    const phases: string[] = []
    const target = (id: string) => ({
      id, home: seats.homeFor(BOB, 'claude-code'), binaryPath: 'fixture-claude',
      launch: { env: { HOME: seats.homeFor(BOB, 'claude-code') } },
      changed: async (phase: string) => { phases.push(`${id}:${phase}`) },
      verify: async () => true,
    })
    let ready = new Promise<void>((resolve) => { spawnedSignal = resolve })
    const first = connector.start(BOB, 'claude-code', target('work'))
    await ready
    spawned[0]!.child.stdout.emit('data', 'Browser didn’t open, visit: https://claude.ai/oauth/authorize?instance=work\n')
    await first
    ready = new Promise<void>((resolve) => { spawnedSignal = resolve })
    const second = connector.start(BOB, 'claude-code', target('personal'))
    await ready
    spawned[1]!.child.stdout.emit('data', 'Browser didn’t open, visit: https://claude.ai/oauth/authorize?instance=personal\n')
    await second
    connector.submitCode(BOB, 'claude-code', 'work-code', 'work')
    connector.submitCode(BOB, 'claude-code', 'personal-code', 'personal')
    expect(spawned[0]!.child.stdinWrites).toEqual(['work-code\n'])
    expect(spawned[1]!.child.stdinWrites).toEqual(['personal-code\n'])
    await connector.cancel(BOB, 'claude-code', 'work')
    expect(spawned[0]!.child.killed).toBe('SIGTERM')
    expect(spawned[1]!.child.killed).toBeNull()
    await connector.cancel(BOB, 'claude-code', 'personal')
    expect(phases).toContain('work:failed')
    expect(events).toEqual([])
  })
  test('Claude: the login runs in the seat directory with the shim first on PATH and no host credential; the printed URL comes back needing a code', async () => {
    const { seats, connector, spawned } = harness()
    process.env.ANTHROPIC_API_KEY = 'host-key'
    try {
      const started = connector.start(BOB, 'claude-code')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const [spawn] = spawned
      // WHY: the program matters, not its spelling: Windows resolves the full `claude.exe` path.
      expect(basename(spawn?.command ?? '', '.exe')).toBe('claude')
      expect(spawn?.args).toEqual(['auth', 'login'])
      expect(spawn?.env.CLAUDE_CONFIG_DIR).toBe(seats.homeFor(BOB, 'claude-code'))
      expect(spawn?.env.PATH?.startsWith(seats.shimBinDir())).toBe(true)
      expect(spawn?.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect((await seats.status(BOB, 'claude-code')).state).toBe('connecting')
      spawn!.child.stdout.emit('data', 'Browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true\nPaste code here if prompted > ')
      const result = await started
      expect(result).toEqual({ verificationUrl: 'https://claude.ai/oauth/authorize?code=true', requiresCodeInput: true })
      connector.submitCode(BOB, 'claude-code', ' abc-123 ')
      expect(spawn!.child.stdinWrites).toEqual(['abc-123\n'])
      spawn!.child.emit('close', 0, null)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await seats.status(BOB, 'claude-code')).toMatchObject({ state: 'connected', method: 'login' })
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  test('Claude: a link printed as an OSC 8 hyperlink comes back as the bare URL, and only once it has fully arrived', async () => {
    // WHY: Claude Code 2.1.330 prints `ESC]8;;<url>BEL<url>ESC]8;;BEL`. Left in, the escape
    // codes glued the URL to its copy and claude.ai rejected the link for a missing client id.
    const { connector, spawned } = harness()
    const started = connector.start(BOB, 'claude-code')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const child = spawned[0]!.child
    const url = 'https://claude.ai/oauth/authorize?z-nmm6Mgh82FwCm8Q11T4X6YYGdNwMUxo34izc9_ZJKy8'
    const output = `Opening browser to sign in…\nIf the browser didn't open, visit:\n\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\nPaste code here if prompted > `
    let settled = false
    void started.then(() => { settled = true })
    // Cut inside the opening sequence, then inside the visible link: neither half is a link yet.
    const cuts = [output.indexOf(url) + 20, output.lastIndexOf(url) + 30, output.length]
    let from = 0
    for (const cut of cuts) {
      child.stdout.emit('data', output.slice(from, cut))
      from = cut
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (cut < output.length) expect(settled).toBe(false)
    }
    expect(await started).toEqual({ verificationUrl: url, requiresCodeInput: true })
    await connector.cancel(BOB, 'claude-code')
  })

  test('Codex: the device flow answers with URL and code; a clean exit with no credential is a failure, not a seat', async () => {
    const { seats, connector, spawned, events } = harness(false)
    const started = connector.start(BOB, 'codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [spawn] = spawned
    expect(spawn?.args).toEqual(['login', '--device-auth'])
    expect(spawn?.env.CODEX_HOME).toBe(seats.homeFor(BOB, 'codex'))
    spawn!.child.stdout.emit('data', 'Open https://auth.openai.com/codex/device\nEnter code: ABCD-EFGH\n')
    const result = await started
    expect(result).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', requiresCodeInput: false })
    spawn!.child.emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await seats.status(BOB, 'codex')).state).toBe('none')
    // The reason rides the event to the member's client; a seat that never was has no row to keep it on.
    expect(events.at(-1)).toMatchObject({ state: 'none', error: expect.stringMatching(/no credential was saved/) })
  })

  test('Antigravity: a clean exit of the Google sign-in connects the seat, though agy kept the token in the keychain', async () => {
    // WHY: agy 1.5 on macOS saves a Google sign-in in the OS keychain, not in the profile, so a file check refused every good sign-in.
    const { seats, connector, spawned } = harness(false)
    const started = connector.start(HOST_LOGIN_SEAT, 'antigravity')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [spawn] = spawned
    expect(spawn?.args).toContain('--login')
    spawn!.child.stdout.emit('data', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y\n')
    expect(await started).toMatchObject({ verificationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y', requiresCodeInput: true })
    spawn!.child.emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await seats.status(HOST_LOGIN_SEAT, 'antigravity')).state).toBe('connected')
    expect(antigravitySignedIn(seats.homeFor(HOST_LOGIN_SEAT, 'antigravity'))).toBe(true)
  })

  test('Antigravity: a Google sign-in that agy refused leaves no seat', async () => {
    // The host login's profile is shared by these tests: start this one signed out.
    rmSync(join(hostAntigravityProfile(), ANTIGRAVITY_SIGN_IN_FILE), { force: true })
    const { seats, connector, spawned } = harness(false)
    const started = connector.start(HOST_LOGIN_SEAT, 'antigravity')
    await new Promise((resolve) => setTimeout(resolve, 0))
    spawned[0]!.child.stdout.emit('data', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y\n')
    await started
    spawned[0]!.child.emit('close', 1, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await seats.status(HOST_LOGIN_SEAT, 'antigravity')).state).not.toBe('connected')
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
    const started = owner.start(HOST_LOGIN_SEAT, 'claude-code')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [spawn] = spawned
    expect(spawn?.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(spawn?.env.PATH?.includes(`${sep}bin`)).toBe(true)
    spawn!.child.stdout.emit('data', 'Browser didn\'t open, visit: https://claude.ai/oauth/authorize\n')
    await started
    spawn!.child.emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probed).toEqual([null])
  })

  test('a non-zero exit before any URL rejects the start and leaves no seat; cancel ends the process', async () => {
    const { seats, connector, spawned } = harness()
    const started = connector.start(BOB, 'codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    spawned[0]!.child.stdout.emit('data', 'network is down\n')
    spawned[0]!.child.emit('close', 1, null)
    await expect(started).rejects.toThrow(/exited with code 1/)
    expect((await seats.status(BOB, 'codex')).state).toBe('none')

    const second = connector.start(BOB, 'codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await connector.cancel(BOB, 'codex')).toBe(true)
    expect(spawned[1]!.child.killed).toBe('SIGTERM')
    await expect(second).rejects.toThrow(/cancelled/)
    await expect(connector.submitCode(BOB, 'codex', 'x')).rejects.toThrow(/not waiting/)
  })
})
