import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Agents are always launched with the plugins path, so a source that resolves
 * anywhere but the app-bundled resources tree silently strips every bundled
 * skill. The source must be anchored to the app root, never to the emitting
 * module's directory: the main bundle is code-split, and the plugin module
 * lands in a nested chunk directory.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'solus-data-'))
const installDir = mkdtempSync(join(tmpdir(), 'solus-install-'))
const originalDataDir = process.env.SOLUS_DATA_DIR
const originalInstallDir = process.env.SOLUS_INSTALL_DIR

// The plugin module reads the state dir once at import time, so the override
// has to be in place before it loads.
process.env.SOLUS_DATA_DIR = dataDir
const { syncBundledPlugins, PLUGINS_DIR, SOLUS_PLUGINS_DIR } = await import('@solus/server/agents/plugins')
const { bundledResourcesDir } = await import('@solus/server/platform/paths')

describe('bundled plugin sync', () => {
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(installDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
    if (originalInstallDir === undefined) delete process.env.SOLUS_INSTALL_DIR
    else process.env.SOLUS_INSTALL_DIR = originalInstallDir
  })

  test('resolves the bundled source from the install root, not the calling module', () => {
    process.env.SOLUS_INSTALL_DIR = '/opt/solus-server'
    expect(bundledResourcesDir()).toBe('/opt/solus-server/resources')
  })

  test('leaves the state dir untouched when the bundled source is missing', async () => {
    process.env.SOLUS_INSTALL_DIR = join(installDir, 'no-such-root')

    await syncBundledPlugins()

    expect(existsSync(PLUGINS_DIR)).toBe(false)
  })

  test('links the bundled plugins into the state dir so agents get a real path', async () => {
    const skillDir = join(installDir, 'resources', 'plugins', 'solus', 'skills', 'diagrams')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# diagrams\n')
    process.env.SOLUS_INSTALL_DIR = installDir

    await syncBundledPlugins()

    expect(PLUGINS_DIR).toBe(join(dataDir, 'plugins'))
    expect(existsSync(join(SOLUS_PLUGINS_DIR, 'skills', 'diagrams', 'SKILL.md'))).toBe(true)
  })
})
