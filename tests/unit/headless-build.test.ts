import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHeadless, copyClient, parseTarget } from '../../scripts/package-server'

test('headless packaging works without a web client build and omits existing client files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-headless-client-'))
  try {
    const client = join(directory, 'client')
    const staging = join(directory, 'staging')
    copyClient(staging, true, client)
    mkdirSync(client)
    writeFileSync(join(client, 'index.html'), 'client build')
    copyClient(staging, true, client)
    expect(existsSync(join(staging, 'libexec', 'client'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the standard package requires and includes the web client', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-full-client-'))
  try {
    const client = join(directory, 'client')
    const staging = join(directory, 'staging')
    expect(() => copyClient(staging, false, client)).toThrow('Web client build missing')
    mkdirSync(client)
    writeFileSync(join(client, 'index.html'), 'client build')
    copyClient(staging, false, client)
    expect(readFileSync(join(staging, 'libexec', 'client', 'index.html'), 'utf8')).toBe('client build')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('headless is opt-in and works with cross-platform package targets', () => {
  expect(parseTarget(['--platform', 'linux', '--arch', 'amd64'])).toEqual({ platform: 'linux', arch: 'x64', headless: false })
  expect(parseTarget(['--headless', '--platform=linux', '--arch=arm64'])).toEqual({ platform: 'linux', arch: 'arm64', headless: true })
  expect(() => parseTarget(['--headles'])).toThrow('Unknown package-server option')
})

test('the standalone build includes the runtime, CLI, and migrations without client or Electron bundles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-headless-build-'))
  try {
    await buildHeadless(directory)
    expect(existsSync(join(directory, 'libexec', 'server', 'standalone.js'))).toBe(true)
    for (const dialect of ['sqlite', 'postgres']) {
      expect(existsSync(join(directory, 'libexec', 'server', 'drizzle', dialect, 'meta', '_journal.json'))).toBe(true)
    }
    expect(existsSync(join(directory, 'libexec', 'cli', 'solus.js'))).toBe(true)
    expect(existsSync(join(directory, 'libexec', 'client'))).toBe(false)
    expect(existsSync(join(directory, 'renderer'))).toBe(false)
    expect(existsSync(join(directory, 'preload'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
