import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { whichAgentBinary } from '@solus/server/transport/handlers/setup-handlers'

const previousDataDir = process.env.SOLUS_DATA_DIR
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('which agent CLIs the host has', () => {
  test('an agent CLI that Solus installed counts as installed, though it is not on PATH', async () => {
    // WHY: a Solus install is selected by a file and never put on PATH. The check ran `which`
    // alone, so a host with only the Solus copy of agy offered Install and Sign in again after both worked.
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-agents-'))
    roots.push(dataDir)
    process.env.SOLUS_DATA_DIR = dataDir
    const release = join(dataDir, 'agents', 'agy', 'releases', '1.5.18-test')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'antigravity'), '#!/bin/sh\n')
    chmodSync(join(release, 'antigravity'), 0o755)
    writeFileSync(join(dataDir, 'agents', 'agy', 'current.json'), JSON.stringify({ release: '1.5.18-test', binary: 'antigravity', version: '1.5.18' }))

    expect(await whichAgentBinary('antigravity')).toBe(join(release, 'antigravity'))
  })
})
