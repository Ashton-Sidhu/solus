import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const STATIC_ELECTRON_IMPORT = /\bimport(?:\s+type)?[\s\S]*?\bfrom\s+['"]electron['"]/g

const ALLOWED = new Set([
  'src/main/desktop-notifications.ts',
  'src/main/index.ts',
  'src/main/updater.ts',
  'src/main/server/handlers/file-handlers.ts',
  'src/main/server/handlers/theme-handlers.ts',
])

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
  test('static electron imports stay confined to the desktop allowlist', () => {
    const offenders = listSourceFiles(join(process.cwd(), 'src/main'))
      .map((path) => {
        const source = readFileSync(path, 'utf8')
        STATIC_ELECTRON_IMPORT.lastIndex = 0
        return { path: relative(process.cwd(), path), hasElectronImport: STATIC_ELECTRON_IMPORT.test(source) }
      })
      .filter(({ path, hasElectronImport }) => hasElectronImport && !ALLOWED.has(path))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })
})
