import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const roots = ['src', 'client/src']
const scannedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.svelte'])
const fullyAllowed = new Set([
  'src/client-core/host-api.ts',
  'src/renderer/main.ts',
  'src/client-core/native-api-overlay.ts',
  'src/client-core/local-api.ts',
  'client/src/main.ts',
])

interface Rule {
  label: string
  pattern: RegExp
}

const rules: Rule[] = [
  { label: 'HostApi cast', pattern: /\bas\s+HostApi\b/g },
  { label: 'SolusAPI cast', pattern: /\bas\s+SolusAPI\b/g },
  { label: 'ambient Solus API type cast', pattern: /\bas\s+typeof\s+window\.solus\b/g },
  // Deliberately practical, not a parser: this catches a bare API-handle
  // identifier immediately before `as any` (api, hostApi, solus, and peers).
  { label: 'API handle cast to any', pattern: /\b(?:solus|[A-Za-z_$][\w$]*(?:Api|api))\s+as\s+any\b/g },
  { label: 'ambient window.solus member access', pattern: /\bwindow\.solus\s*\./g },
]

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (scannedExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

function repoPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

function isAllowed(path: string): boolean {
  return fullyAllowed.has(path) || path.startsWith('src/preload/')
}

const violations: string[] = []
for (const root of roots) {
  for (const file of await sourceFiles(join(process.cwd(), root))) {
    const path = repoPath(file)
    if (isAllowed(path)) continue
    const source = await readFile(file, 'utf8')
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      for (const match of source.matchAll(rule.pattern)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${path}:${line}: ${rule.label}`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Host-discipline check failed with ${violations.length} violation(s):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}

console.log('Host-discipline check passed with zero violations.')
