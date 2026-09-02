import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CloudflaredConnector, type ConnectorObservation, type SpawnLike } from '@solus/server/server/uplink/connector'

// docs/plans/personal-uplink.md H3: the run token travels only in the child's
// environment, the connector's output becomes the observed state, and a crashed
// connector comes back on its own for as long as the link is desired.

function fakeCloudflared(dir: string, behaviour: 'serve' | 'crash'): string {
  const path = join(dir, 'cloudflared')
  const script = behaviour === 'serve'
    ? [
        '#!/usr/bin/env node',
        'if (process.argv.slice(2).join(" ") !== "tunnel --no-autoupdate run") { console.error("bad args"); process.exit(2) }',
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
