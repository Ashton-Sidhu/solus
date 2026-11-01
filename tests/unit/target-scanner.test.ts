import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { ProbeResult } from '@solus/server/browser/target-scanner'

// The scanner's git helpers reach the database module, which Bun loads only through this mock.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { ProbeVerdicts, windowsListeners } = await import('@solus/server/browser/target-scanner')

// Windows has no lsof, so the browser pane finds dev servers from `netstat -ano`
// (docs/plans/windows.md §5.14).

const ENGLISH = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1432',
  '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8812',
  '  TCP    127.0.0.1:5173         127.0.0.1:61234        ESTABLISHED     8812',
  '  TCP    192.168.1.20:61500     140.82.112.4:443       TIME_WAIT       0',
].join('\r\n')

const GERMAN_IPV6 = [
  'Aktive Verbindungen',
  '',
  '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
  '  TCP    [::]:3000              [::]:0                 ABHÖREN          19568',
  '  TCP    [::1]:5173             [::1]:61235            HERGESTELLT      8812',
].join('\r\n')

describe('listening sockets on Windows', () => {
  test('a listener is read from its foreign address, so the translated state column does not matter', () => {
    // WHY: the state column is translated; a German Windows says ABHÖREN.
    expect(windowsListeners(GERMAN_IPV6)).toEqual([{ pid: 19568, port: 3000, command: '' }])
  })

  test('open connections and closing ones are not listeners', () => {
    expect(windowsListeners(ENGLISH)).toEqual([
      { pid: 1432, port: 135, command: '' },
      { pid: 8812, port: 5173, command: '' },
    ])
  })

  test('headers, blank lines, and UDP rows are skipped', () => {
    expect(windowsListeners('Active Connections\r\n\r\n  UDP    0.0.0.0:5353   *:*   2208')).toEqual([])
  })
})

// Each scan probes listeners with `GET /`. Redis, Postgres, and other non-HTTP
// services read that as junk, so a process's port is probed once while it lives.
describe('probe verdicts', () => {
  const redis = { pid: 100, port: 6379, command: 'redis-server' }
  const vite = { pid: 200, port: 5173, command: 'node' }

  function countingProbe(results: Record<number, ProbeResult>) {
    const calls: number[] = []
    const verdicts = new ProbeVerdicts(async (port) => {
      calls.push(port)
      return results[port]
    })
    return { calls, verdicts }
  }

  test('repeated scans do not probe a known listener again', async () => {
    const { calls, verdicts } = countingProbe({ 6379: { kind: 'other' }, 5173: { kind: 'html', title: 'App' } })
    for (let scan = 0; scan < 5; scan++) {
      expect(await verdicts.verdictsFor([redis, vite], 1000 + scan * 60_000)).toEqual([
        { kind: 'other' },
        { kind: 'html', title: 'App' },
      ])
    }
    expect(calls).toEqual([6379, 5173])
  })

  test('a listener that disappears is forgotten, and a new process on its port is probed fresh', async () => {
    const { calls, verdicts } = countingProbe({ 6379: { kind: 'other' } })
    await verdicts.verdictsFor([redis], 0)
    await verdicts.verdictsFor([], 1)
    await verdicts.verdictsFor([redis], 2)
    await verdicts.verdictsFor([{ ...redis, pid: 101 }], 3)
    expect(calls).toEqual([6379, 6379, 6379])
  })

  test('a timeout is asked again only after the retry window, a dev server may still be starting', async () => {
    const results: Record<number, ProbeResult> = { 5173: { kind: 'timeout' } }
    const { calls, verdicts } = countingProbe(results)
    await verdicts.verdictsFor([vite], 0)
    expect(await verdicts.verdictsFor([vite], 10_000)).toEqual([{ kind: 'timeout' }])
    expect(calls).toHaveLength(1)
    results[5173] = { kind: 'html' }
    expect(await verdicts.verdictsFor([vite], 30_000)).toEqual([{ kind: 'html' }])
    await verdicts.verdictsFor([vite], 90_000)
    expect(calls).toHaveLength(2)
  })
})
