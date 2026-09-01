import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const STATIC_ELECTRON_IMPORT = /\bimport(?:\s+type)?[\s\S]*?\bfrom\s+['"]electron['"]/g

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
    } else if (path.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

describe('main-process Electron imports', () => {
  test('static electron imports stay confined to the desktop app', () => {
    const roots = [
      'apps',
      'packages',
    ]
    const offenders = roots
      .flatMap((root) => listSourceFiles(join(process.cwd(), root)))
      .map((path) => {
        const source = readFileSync(path, 'utf8')
        STATIC_ELECTRON_IMPORT.lastIndex = 0
        return { path: relative(process.cwd(), path), hasElectronImport: STATIC_ELECTRON_IMPORT.test(source) }
      })
      .filter(({ path, hasElectronImport }) => hasElectronImport && !path.startsWith('apps/desktop/'))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })
})
