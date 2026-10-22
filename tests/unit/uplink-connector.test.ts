import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CloudflaredConnector, type ConnectorObservation, type SpawnLike } from '@solus/server/transport/uplink/connector'

// docs/plans/personal-uplink.md H3: the run token travels only in the child's
// environment, the connector's output becomes the observed state, and a crashed
// connector comes back on its own for as long as the link is desired.

function fakeCloudflared(dir: string, behaviour: 'serve' | 'crash'): string {
  const path = join(dir, 'cloudflared')
  const script = behaviour === 'serve'
    ? [
        '#!/usr/bin/env node',
        'if (process.argv.slice(2).join(" ") !== "tunnel --no-autoupdate --metrics 127.0.0.1:0 run") { console.error("bad args"); process.exit(2) }',
        'console.error(process.env.TUNNEL_TOKEN ? "TOKEN_IN_ENV" : "TOKEN_MISSING")',
        'console.error("INF Registered tunnel connection connIndex=0")',
        'console.error("INF Registered tunnel connection connIndex=1")',
        'console.error("INF Unregistered tunnel connection connIndex=0")',
        'process.on("SIGTERM", () => process.exit(0))',
        'setInterval(() => {}, 1000)',
      ]
    : [
        '#!/usr/bin/env node',
        'console.error("ERR failed to connect")',
        'process.exit(1)',
      ]
  writeFileSync(path, `${script.join('\n')}\n`, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function collect() {
  const observations: ConnectorObservation[] = []
  return { observations }
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('the cloudflared connector', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solus-connector-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('runs the binary with the token in the environment and reads "online" off its output', async () => {
    const binary = fakeCloudflared(dir, 'serve')
    const { observations } = collect()
    const seen: string[] = []
    // The fake echoes whether the token reached it; capture that off the child's stderr.
    const spawnImpl: SpawnLike = (command, args, options) => {
      const child = spawn(command, args, options)
      child.stderr?.on('data', (chunk: Buffer) => seen.push(...chunk.toString().split('\n')))
      return child
    }
    const connector = new CloudflaredConnector({
      resolveBinary: () => binary,
      onObservation: (observation) => observations.push(observation),
      spawnImpl,
    })
    connector.start('tunnel-token-abc')
    await waitFor(() => observations.some((o) => o.observed === 'online'))
    await waitFor(() => seen.some((line) => line.includes('connIndex=0') && line.includes('Unregistered')))
    // cloudflared holds several edge connections; losing one of them is not "offline".
    expect(observations).toEqual([{ observed: 'online' }])
    expect(seen.some((line) => line.includes('TOKEN_IN_ENV'))).toBe(true)
    expect(seen.some((line) => line.includes('tunnel-token-abc'))).toBe(false)
    expect(connector.running).toBe(true)

    await connector.stop()
    expect(connector.running).toBe(false)
    expect(observations.at(-1)).toEqual({ observed: 'offline' })
  })

  test('a crashed connector is scheduled to restart with backoff; a stopped one is not', async () => {
    const binary = fakeCloudflared(dir, 'crash')
    const { observations } = collect()
    const scheduled: number[] = []
    const connector = new CloudflaredConnector({
      resolveBinary: () => binary,
      onObservation: (observation) => observations.push(observation),
      // Capture the restart timer instead of letting it fire.
      setTimeoutFn: ((_fn: () => void, delay: number) => { scheduled.push(delay); return { unref() {} } }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })
    connector.start('tunnel-token-abc')
    await waitFor(() => scheduled.length === 1)
    expect(observations).toContainEqual({ observed: 'offline' })
    expect(scheduled[0]).toBe(1_000)
    await connector.stop()
    expect(scheduled).toHaveLength(1)
  })

  test('without a binary the link reports an error, and keeps looking for one', () => {
    const { observations } = collect()
    const scheduled: number[] = []
    const connector = new CloudflaredConnector({
      resolveBinary: () => null,
      onObservation: (observation) => observations.push(observation),
      setTimeoutFn: ((_fn: () => void, delay: number) => { scheduled.push(delay); return { unref() {} } }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })
    connector.start('tunnel-token-abc')
    expect(observations).toEqual([{ observed: 'error', error: 'cloudflared is not installed on this host' }])
    expect(connector.running).toBe(false)
    // Installing it later must not need an unlink and relink.
    expect(scheduled).toHaveLength(1)
  })
})

// A child process the test drives line by line. kill() exits it at once.
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  constructor(readonly pid: number) { super() }
  kill(signal: string): boolean {
    this.signals.push(signal)
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
  say(line: string): void { this.stderr.emit('data', Buffer.from(`${line}\n`)) }
}

const METRICS_LINE = (port: number) => `2026-10-14T08:49:04Z INF Starting metrics server on 127.0.0.1:${port}/metrics`
const QUIC_STALL_LINE = '2026-10-16T20:29:43Z ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=1'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function harness(env: NodeJS.ProcessEnv = {}) {
  const children: FakeChild[] = []
  const spawnArgs: string[][] = []
  const restarts: Array<() => void> = []
  const intervals = new Map<number, () => void>()
  let nextInterval = 1
  const readyAnswers: Array<number | 'refused'> = []
  const readyUrls: string[] = []
  let clock = 0
  const connector = new CloudflaredConnector({
    resolveBinary: () => '/fake/cloudflared',
    onObservation: () => {},
    env,
    now: () => clock,
    spawnImpl: (_command, args) => {
      spawnArgs.push([...args])
      const child = new FakeChild(100 + children.length)
      children.push(child)
      return child as unknown as ChildProcess
    },
    setTimeoutFn: ((fn: () => void, delay: number) => {
      // Only the restart backoff schedules here; the stop grace timer is not needed.
      if (delay !== 3_000) restarts.push(fn)
      return { unref() {} }
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
    setIntervalFn: ((fn: () => void) => {
      const id = nextInterval++
      intervals.set(id, fn)
      return { id, unref() {} }
    }) as unknown as typeof setInterval,
    clearIntervalFn: ((timer: { id: number }) => { intervals.delete(timer.id) }) as unknown as typeof clearInterval,
    fetchReady: async (url) => {
      readyUrls.push(url)
      const answer = readyAnswers.shift() ?? 503
      if (answer === 'refused') throw new Error('connection refused')
      return { status: answer }
    },
  })
  // Fires the readiness interval once and lets its answer land.
  const poll = async (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      expect(intervals.size).toBe(1)
      for (const fn of intervals.values()) fn()
      await flush()
    }
  }
  const fireRestart = () => { restarts.shift()?.() }
  return {
    connector, children, spawnArgs, restarts, intervals, readyAnswers, readyUrls, poll, fireRestart,
    advance: (ms: number) => { clock += ms },
  }
}

describe('the cloudflared readiness watchdog', () => {
  test('restarts a child whose /ready keeps answering 503, not before six in a row', async () => {
    const h = harness()
    h.connector.start('tunnel-token-abc')
    h.children[0].say(METRICS_LINE(40000))
    // Five 503s, a failed request that says nothing, a ready answer that clears the streak.
    h.readyAnswers.push(503, 503, 503, 503, 503, 'refused', 200)
    await h.poll(7)
    await h.poll(5)
    expect(h.children[0].signals).toEqual([])
    expect(h.readyUrls[0]).toBe('http://127.0.0.1:40000/ready')
    await h.poll(1)
    expect(h.children[0].signals).toEqual(['SIGTERM'])
    await flush()
    // The child exit stops polling and goes through the normal restart backoff.
    expect(h.intervals.size).toBe(0)
    expect(h.restarts).toHaveLength(1)
    h.fireRestart()
    expect(h.children).toHaveLength(2)

    // A restart that never saw a ready answer doubles the count for the next child.
    h.children[1].say(METRICS_LINE(40001))
    await h.poll(11)
    expect(h.children[1].signals).toEqual([])
    await h.poll(1)
    expect(h.children[1].signals).toEqual(['SIGTERM'])
    await h.connector.stop()
  })

  test('a ready answer brings the threshold back to six', async () => {
    const h = harness()
    h.connector.start('tunnel-token-abc')
    h.children[0].say(METRICS_LINE(40000))
    await h.poll(6)
    await flush()
    h.fireRestart()
    h.children[1].say(METRICS_LINE(40001))
    h.readyAnswers.push(200)
    await h.poll(1)
    await h.poll(5)
    expect(h.children[1].signals).toEqual([])
    await h.poll(1)
    expect(h.children[1].signals).toEqual(['SIGTERM'])
    await h.connector.stop()
  })

  test('stop() ends polling, and a child without a metrics line is never polled', async () => {
    const h = harness()
    h.connector.start('tunnel-token-abc')
    expect(h.intervals.size).toBe(0)
    h.children[0].say(METRICS_LINE(40000))
    expect(h.intervals.size).toBe(1)
    await h.connector.stop()
    expect(h.intervals.size).toBe(0)
    expect(h.readyUrls).toEqual([])
  })
})

describe('the cloudflared QUIC to HTTP/2 fallback', () => {
  test('switches to --protocol http2 after 30 QUIC stalls in five minutes, and keeps it', async () => {
    const h = harness()
    h.connector.start('tunnel-token-abc')
    expect(h.spawnArgs[0]).not.toContain('--protocol')
    for (let i = 0; i < 20; i += 1) h.children[0].say(QUIC_STALL_LINE)
    h.advance(4 * 60_000)
    for (let i = 0; i < 9; i += 1) h.children[0].say(QUIC_STALL_LINE)
    // 29 stalls: one short.
    expect(h.children[0].signals).toEqual([])
    // The first 20 leave the window; the newer 9 must survive a crash and restart.
    h.advance(60_000)
    h.children[0].emit('exit', 1, null)
    h.fireRestart()
    expect(h.spawnArgs[1]).not.toContain('--protocol')
    for (let i = 0; i < 20; i += 1) h.children[1].say(QUIC_STALL_LINE)
    expect(h.children[1].signals).toEqual([])
    h.children[1].say(QUIC_STALL_LINE)
    expect(h.children[1].signals).toEqual(['SIGTERM'])
    await flush()
    h.fireRestart()
    expect(h.spawnArgs[2]).toEqual(['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--protocol', 'http2', 'run'])
    // Sticky for the life of the connector, also after a crash.
    h.children[2].emit('exit', 1, null)
    h.fireRestart()
    expect(h.spawnArgs[3]).toContain('http2')
    await h.connector.stop()
  })

  test('an explicit TUNNEL_TRANSPORT_PROTOCOL wins over the fallback', async () => {
    const h = harness({ TUNNEL_TRANSPORT_PROTOCOL: 'quic' })
    h.connector.start('tunnel-token-abc')
    for (let i = 0; i < 60; i += 1) h.children[0].say(QUIC_STALL_LINE)
    expect(h.children[0].signals).toEqual([])
    expect(h.children).toHaveLength(1)
    expect(h.spawnArgs[0]).not.toContain('--protocol')
    await h.connector.stop()
  })
})
