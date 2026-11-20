import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appNode } from '@solus/server/apps/app-node'

const root = mkdtempSync(join(tmpdir(), 'solus-app-node-'))
const tools = join(root, 'tools')
const empty = join(root, 'empty')
mkdirSync(tools)
mkdirSync(empty)
const node = join(tools, process.platform === 'win32' ? 'node.exe' : 'node')
writeFileSync(node, '')
chmodSync(node, 0o755)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const host = (versions: { electron?: string; bun?: string }) => ({
  execPath: join(root, 'Solus'),
  versions: { ...process.versions, electron: undefined, bun: undefined, ...versions },
})

describe('Node for app builds and backends', () => {
  test('Electron uses Node from PATH without starting the Solus executable', () => {
    // Packaged Solus disables RunAsNode, so even a capability probe of execPath opens the GUI.
    expect(appNode(host({ electron: '44.0.0' }), tools)).toBe(node)
  })

  test('Bun uses Node so the backend has the Node permission model', () => {
    expect(appNode(host({ bun: '1.3.0' }), tools)).toBe(node)
  })

  test('a Node server keeps its own runtime even when PATH has no Node', () => {
    const runtime = host({})
    expect(appNode(runtime, empty)).toBe(runtime.execPath)
  })

  test('missing Node reports the requirement without a fallback to Solus', () => {
    expect(() => appNode(host({ electron: '44.0.0' }), empty)).toThrow('Apps require Node.js 22 or later on this host.')
    expect(() => appNode(host({ bun: '1.3.0' }), empty)).toThrow('Install Node.js and restart Solus.')
  })
})
