import { describe, expect, test } from 'bun:test'
import { defaultDataDir, healthUrl, parseLockFile, parsePidFile } from '../../src/cli/lib/runtime'

describe('solus CLI runtime parsing', () => {
  test('parses the server lock shape used to locate the daemon health endpoint', () => {
    const lock = parseLockFile(JSON.stringify({
      pid: 12345,
      port: 3007,
      host: '0.0.0.0',
      startedAt: 1_775_000_000_000,
    }))

    expect(lock).toEqual({
      pid: 12345,
      port: 3007,
      host: '0.0.0.0',
      startedAt: 1_775_000_000_000,
    })
    expect(healthUrl(lock!)).toBe('http://127.0.0.1:3007/health')
  })

  test('rejects malformed lock and pid files instead of controlling an unknown process', () => {
    expect(parseLockFile('not json')).toBeNull()
    expect(parseLockFile(JSON.stringify({ pid: -1, port: 3000, host: '127.0.0.1', startedAt: Date.now() }))).toBeNull()
    expect(parseLockFile(JSON.stringify({ pid: 1, port: 70000, host: '127.0.0.1', startedAt: Date.now() }))).toBeNull()
    expect(parseLockFile(JSON.stringify({ pid: 1, port: 3000, host: '', startedAt: Date.now() }))).toBeNull()
    expect(parsePidFile('abc')).toBeNull()
    expect(parsePidFile('0')).toBeNull()
  })

  test('prefers explicit SOLUS_DATA_DIR over the default home directory', () => {
    expect(defaultDataDir({ SOLUS_DATA_DIR: '/tmp/solus-data' }, '/home/tester')).toBe('/tmp/solus-data')
    expect(defaultDataDir({}, '/home/tester')).toBe('/home/tester/.solus')
  })
})
