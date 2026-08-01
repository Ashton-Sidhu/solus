import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { solusDir } from '../../src/main/platform/paths'

describe('Solus state paths', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('resolves the isolated data directory at call time', () => {
    process.env.SOLUS_DATA_DIR = '/tmp/solus-first'
    expect(solusDir()).toBe('/tmp/solus-first')

    process.env.SOLUS_DATA_DIR = '/tmp/solus-second'
    expect(solusDir()).toBe('/tmp/solus-second')
  })

  test('keeps the existing shared state directory by default', () => {
    delete process.env.SOLUS_DATA_DIR
    expect(solusDir()).toBe(join(homedir(), '.solus'))
  })

  test('treats an empty environment override as unset', () => {
    process.env.SOLUS_DATA_DIR = ''
    expect(solusDir()).toBe(join(homedir(), '.solus'))
  })
})
