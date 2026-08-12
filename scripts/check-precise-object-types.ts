import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const scannedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.svelte'])
const roots = ['src', 'client/src', 'tests', 'scripts', 'web/src']
const ignoredDirectories = new Set(['node_modules'])
const broadUnknownRecord = /\bRecord\s*<\s*string\s*,\s*unknown\s*>/g

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (scannedExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

function repoPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

const violations: string[] = []
for (const root of roots) {
  for (const file of await sourceFiles(join(process.cwd(), root))) {
    const path = repoPath(file)
    const source = await readFile(file, 'utf8')
    broadUnknownRecord.lastIndex = 0
    for (const match of source.matchAll(broadUnknownRecord)) {
      const line = source.slice(0, match.index).split('\n').length
      violations.push(`${path}:${line}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`Precise-object-type check failed with ${violations.length} violation(s):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}

console.log('Precise-object-type check passed with zero violations.')
