import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string | undefined

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = undefined
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

async function loadSettings(name: string, persisted?: object) {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-server-settings-'))
  process.env.SOLUS_DATA_DIR = dataDir
  if (persisted) writeFileSync(join(dataDir, 'server-settings.json'), JSON.stringify(persisted))
  return import(`../../src/main/server/settings.ts?${name}`)
}

describe.serial('server settings defaults', () => {
  test('allows remote connections for a new installation', async () => {
    const settings = await loadSettings('new-installation')
    expect(settings.getServerSettings().remoteAccess).toBe(true)
  })

  test('preserves an explicit remote access opt-out', async () => {
    const settings = await loadSettings('remote-access-disabled', { remoteAccess: false })
    expect(settings.getServerSettings().remoteAccess).toBe(false)
  })
})
