import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { findAppBundle } from '@solus/desktop-main/mac-apps'

const describeMac = process.platform === 'darwin' ? describe : describe.skip

describeMac('findAppBundle', () => {
  test('finds a bundle outside /Applications', async () => {
    // WHY: probing only /Applications missed both per-user installs and the
    // system utilities, which is half of why Settings looked empty.
    expect(findAppBundle('Terminal.app')).toBe('/System/Applications/Utilities/Terminal.app')
  })

  test('answers null for an application that is not installed', () => {
    expect(findAppBundle('Definitely Not Installed.app')).toBeNull()
  })
})

describeMac('findAppBundle with editions and versions', () => {
  const directories: string[] = []
  afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

  function appsDirectory(...bundles: string[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'solus-mac-apps-'))
    directories.push(directory)
    for (const bundle of bundles) mkdirSync(join(directory, bundle))
    return directory
  }

  test('finds a versioned or edition bundle when the exact name is missing', () => {
    // WHY: JetBrains Toolbox installs `IntelliJ IDEA 2026.1.4.app` and editions
    // ship as `PyCharm CE.app`. An exact-name probe hid both IDEs.
    const directory = appsDirectory('IntelliJ IDEA 2026.1.4.app', 'PyCharm CE.app')
    expect(findAppBundle('IntelliJ IDEA.app', [directory])).toBe(join(directory, 'IntelliJ IDEA 2026.1.4.app'))
    expect(findAppBundle('PyCharm.app', [directory])).toBe(join(directory, 'PyCharm CE.app'))
  })

  test('an exact bundle in any directory wins over a variant', () => {
    const variants = appsDirectory('IntelliJ IDEA CE.app')
    const exact = appsDirectory('IntelliJ IDEA.app')
    expect(findAppBundle('IntelliJ IDEA.app', [variants, exact])).toBe(join(exact, 'IntelliJ IDEA.app'))
  })

  test('picks the highest version among several, by number rather than by text', () => {
    // WHY: the choice must be stable, and 2026.10 is newer than 2026.9.
    const directory = appsDirectory('IntelliJ IDEA 2026.9.app', 'IntelliJ IDEA 2026.10.app')
    expect(findAppBundle('IntelliJ IDEA.app', [directory])).toBe(join(directory, 'IntelliJ IDEA 2026.10.app'))
  })

  test('a name that only shares a prefix is not a variant', () => {
    const directory = appsDirectory('PyCharmTools.app', 'PyCharm CE.txt')
    expect(findAppBundle('PyCharm.app', [directory])).toBeNull()
  })
})
