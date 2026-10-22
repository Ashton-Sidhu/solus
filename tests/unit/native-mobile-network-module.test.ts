import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * expo-network's `getNetworkStateAsync` waits for the first path from a
 * temporary NWPathMonitor. Cancellation does not drain queued updates, so a
 * late callback could replace the path while the caller retained it on
 * another queue, and iOS crashed (T3 Code #22043). The patch in
 * `patches/expo-network@58.0.3.patch` keeps only the first path behind a
 * lock. This test compiles the installed (patched) query methods with a fake
 * NWPathMonitor under the thread sanitizer, so it fails when the patch is
 * lost or no longer applies to the installed version.
 */

const root = resolve(import.meta.dir, '../..')
const expoNetwork = dirname(
  require.resolve('expo-network/package.json', { paths: [join(root, 'apps/mobile')] }),
)

describe.skipIf(platform() !== 'darwin')('expo-network NetworkModule path handoff', () => {
  let directory: string
  let executable: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'solus-network-test-'))
    executable = join(directory, 'network-regression')
    const source = readFileSync(join(expoNetwork, 'ios/NetworkModule.swift'), 'utf8')
    // Compile the dependency's query and conversion methods, replacing only
    // NWPathMonitor so the fixture can deliver updates during and after cancellation.
    const start = source.indexOf('  private func getNetworkPathAsync()')
    if (start === -1) throw new Error('NetworkModule query implementation not found')
    const methods = source
      .slice(start, source.lastIndexOf('\n}'))
      .replace('private func getNetworkStateAsync', 'func getNetworkStateAsync')
    const module = join(directory, 'NetworkModule.swift')
    writeFileSync(
      module,
      `import Foundation\nfinal class NetworkModule {\n  private let monitorQueue = DispatchQueue.global(qos: .default)\n${methods}\n}\n`,
    )
    const types = join(directory, 'NetworkType.swift')
    writeFileSync(
      types,
      readFileSync(join(expoNetwork, 'ios/NetworkType.swift'), 'utf8').replace(/^import Network\n/m, ''),
    )
    execFileSync(
      'swiftc',
      [
        '-swift-version',
        '5',
        '-sanitize=thread',
        module,
        types,
        join(root, 'tests/fixtures/NetworkModuleRegression.swift'),
        '-o',
        executable,
      ],
      { timeout: 120_000, encoding: 'utf8' },
    )
  }, 150_000)

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  test.each([
    ['first', 'keeps the first path when several updates arrive before the query resumes'],
    ['offline', 'reports a disconnected path'],
    ['concurrent', 'reads paths during overlapping queries and late callbacks without data races'],
  ])('%s: %s', (scenario) => {
    // A failed precondition traps and a thread sanitizer report halts with a
    // nonzero status. Read the status: Bun's child_process drops this child's stdout.
    const run = spawnSync(executable, [scenario], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, TSAN_OPTIONS: 'halt_on_error=1' },
    })
    expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null })
  })
})
