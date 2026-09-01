import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
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
const { configurePlatformServices } = await import('@solus/server/platform/services')

/** Stand in for the desktop app's Electron `app`, whose `isPackaged` decides
 *  whether the sync copies or links. */
function runAs(kind: 'dev' | 'packaged', appPath: string): void {
  delete process.env.SOLUS_INSTALL_DIR
  configurePlatformServices({
    appInfo: {
      appPath,
      isPackaged: kind === 'packaged',
      logsPath: join(dataDir, 'logs'),
      userDataPath: dataDir,
      version: '1.0.0-test',
    },
  })
}

describe('bundled plugin sync', () => {
  afterAll(() => {
    configurePlatformServices({})
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(installDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
    if (originalInstallDir === undefined) delete process.env.SOLUS_INSTALL_DIR
    else process.env.SOLUS_INSTALL_DIR = originalInstallDir
  })

  test('resolves the bundled source from the install root, not the calling module', () => {
    configurePlatformServices({})
    process.env.SOLUS_INSTALL_DIR = '/opt/solus-server'
    expect(bundledResourcesDir()).toBe('/opt/solus-server/resources')
  })

  test('leaves the state dir untouched when the bundled source is missing', async () => {
    runAs('dev', join(installDir, 'no-such-root'))

    await syncBundledPlugins()

    expect(existsSync(PLUGINS_DIR)).toBe(false)
  })

  /**
   * Dev is the one runtime that links: an edit under `resources/plugins` has to
   * reach the next agent without a restart, and the copy path is pinned by an
   * app version that never changes between dev builds.
   */
  describe('development', () => {
    const source = join(installDir, 'resources', 'plugins')

    test('links the state dir at the working tree so plugin edits go live', async () => {
      const skillDir = join(source, 'solus', 'skills', 'diagrams')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '# diagrams\n')
      runAs('dev', installDir)

      await syncBundledPlugins()

      expect(PLUGINS_DIR).toBe(join(dataDir, 'plugins'))
      expect(lstatSync(PLUGINS_DIR).isSymbolicLink()).toBe(true)
      expect(readlinkSync(PLUGINS_DIR)).toBe(source)
      expect(existsSync(join(SOLUS_PLUGINS_DIR, 'skills', 'diagrams', 'SKILL.md'))).toBe(true)
    })

    test('follows the source after a plugin edit, with no second sync', async () => {
      writeFileSync(join(source, 'solus', 'skills', 'diagrams', 'SKILL.md'), '# edited\n')

      expect(readFileSync(join(SOLUS_PLUGINS_DIR, 'skills', 'diagrams', 'SKILL.md'), 'utf8')).toBe('# edited\n')
    })
  })

  /**
   * Every packaged runtime copies. The desktop app must — external CLIs cannot
   * follow a symlink into app.asar, and Electron's asar-aware fs does not patch
   * `fs.cp`, so a copy written with it throws ENOENT and strips every bundled
   * skill from the release. The standalone server copies for its own reasons:
   * Windows refuses `symlink()` without Developer Mode, and an install dir
   * replaced by an upgrade would dangle. Bun has no asar layer to exercise, so
   * the asar-unsafe call is pinned out by the source assertion below.
   */
  describe('packaged copy', () => {
    const packagedRoot = mkdtempSync(join(tmpdir(), 'solus-packaged-'))
    const sourceSkill = join(packagedRoot, 'resources', 'plugins', 'solus', 'skills', 'diagrams')

    afterAll(() => rmSync(packagedRoot, { recursive: true, force: true }))

    test('copies the whole tree out of the bundle instead of linking into it', async () => {
      mkdirSync(join(sourceSkill, 'references'), { recursive: true })
      writeFileSync(join(sourceSkill, 'SKILL.md'), '# diagrams\n')
      writeFileSync(join(sourceSkill, 'references', 'nodes.md'), '# nodes\n')
      // A plain directory, not an `app.asar` path: the runtime decides, so a
      // target packaged with `asar: false` still copies.
      runAs('packaged', packagedRoot)

      await syncBundledPlugins()

      const copied = join(SOLUS_PLUGINS_DIR, 'skills', 'diagrams')
      expect(readFileSync(join(copied, 'SKILL.md'), 'utf8')).toBe('# diagrams\n')
      expect(readFileSync(join(copied, 'references', 'nodes.md'), 'utf8')).toBe('# nodes\n')
      expect(lstatSync(PLUGINS_DIR).isSymbolicLink()).toBe(false)
      expect(existsSync(`${PLUGINS_DIR}.incoming`)).toBe(false)
    })

    test('leaves the installed copy alone on a warm launch', async () => {
      const localEdit = join(PLUGINS_DIR, 'solus', 'skills', 'diagrams', 'SKILL.md')
      writeFileSync(localEdit, '# stamped\n')

      await syncBundledPlugins()

      expect(readFileSync(localEdit, 'utf8')).toBe('# stamped\n')
    })

    test('never copies with fs.cp, which cannot read a path inside app.asar', () => {
      const source = readFileSync(new URL('../../packages/server/src/agents/plugins.ts', import.meta.url), 'utf8')
      expect(source).not.toMatch(/\bcp(Sync)?\s*\(/)
    })
  })
})
