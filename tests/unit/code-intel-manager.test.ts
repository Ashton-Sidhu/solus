import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CodeIntelStatus } from '@solus/contracts/code-intel'
import { CodeIntelManager } from '@solus/server/code-intel/code-intel-manager'

/**
 * The manager's contract with the surfaces: the first question about a root
 * builds the index instead of failing, the built index answers, and an edit
 * after indexing is reported as stale rather than hidden.
 *
 * The "indexer" is a shell script in the project's node_modules/.bin that
 * copies the real scip-typescript fixture into place, so the run exercises
 * tool resolution, spawning, decoding, and hashing without the real tool.
 */

const FIXTURE_ROOT = join(import.meta.dir, '__fixtures__', 'scip', 'typescript-project')

let dataDir: string
let projectRoot: string
let manager: CodeIntelManager
const previousDataDir = process.env.SOLUS_DATA_DIR

function waitForState(state: CodeIntelStatus['languages'][number]['state']): Promise<CodeIntelStatus> {
  return new Promise((resolve) => {
    const stop = manager.onStatusChanged((status) => {
      if (status.languages.some((language) => language.language === 'typescript' && language.state === state)) {
        stop()
        resolve(status)
      }
    })
  })
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-code-intel-data-'))
  process.env.SOLUS_DATA_DIR = dataDir
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'solus-code-intel-project-')))
  cpSync(join(FIXTURE_ROOT, 'src'), join(projectRoot, 'src'), { recursive: true })
  cpSync(join(FIXTURE_ROOT, 'tsconfig.json'), join(projectRoot, 'tsconfig.json'))
  cpSync(join(FIXTURE_ROOT, 'package.json'), join(projectRoot, 'package.json'))
  const binDir = join(projectRoot, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const fakeIndexer = join(binDir, 'scip-typescript')
  writeFileSync(
    fakeIndexer,
    `#!/bin/sh\n# args: index --output <path>\nwhile [ "$1" != "--output" ]; do shift; done\ncp "${join(FIXTURE_ROOT, 'index.scip')}" "$2"\n`,
  )
  chmodSync(fakeIndexer, 0o755)
  manager = new CodeIntelManager()
})

afterAll(() => {
  manager.dispose()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('CodeIntelManager', () => {
  test('the first query on a root starts the build and reports it', async () => {
    const ready = waitForState('ready')
    const first = await manager.symbolAt(projectRoot, { path: 'src/main.ts', line: 3, character: 19 })
    expect(first.ok && first.symbol).toBeNull()
    expect(first.ok && first.language?.state).toBe('indexing')
    const status = await ready
    const typescript = status.languages.find((language) => language.language === 'typescript')!
    expect(typescript.documentCount).toBe(2)
    expect(typescript.indexedAt).not.toBeNull()
  })

  test('the built index answers with the definition across files', async () => {
    const result = await manager.symbolAt(projectRoot, { path: 'src/main.ts', line: 3, character: 19 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.freshness).toBe('fresh')
    expect(result.symbol?.name).toBe('add')
    expect(result.symbol?.definition?.path).toBe('src/math.ts')
  })

  test('loads a later reference page with source previews', async () => {
    const symbolResult = await manager.symbolAt(projectRoot, { path: 'src/math.ts', line: 1, character: 17 })
    expect(symbolResult.ok && symbolResult.symbol).not.toBeNull()
    if (!symbolResult.ok || !symbolResult.symbol) return
    const page = await manager.references(projectRoot, {
      language: 'typescript',
      symbol: symbolResult.symbol.symbol,
      offset: 1,
    })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.referenceCount).toBe(3)
    expect(page.references).toHaveLength(2)
    expect(page.references.every((reference) => reference.preview !== null)).toBeTrue()
    expect(page.nextOffset).toBeNull()
  })

  test('requires the root-relative path declared by the RPC contract', async () => {
    const result = await manager.symbolAt(projectRoot, {
      path: join(projectRoot, 'src/main.ts'),
      line: 3,
      character: 19,
    })
    // WHY: callers own the wire shape; the host must not maintain a second,
    // undocumented absolute-path form of the same request.
    expect(result.ok && result.symbol).toBeNull()
  })

  test('a file edited after indexing still answers, marked stale', async () => {
    writeFileSync(join(projectRoot, 'src/main.ts'), `// edited\n${'\n'}import { add } from './math'\n`)
    const result = await manager.symbolAt(projectRoot, { path: 'src/main.ts', line: 3, character: 19 })
    // WHY: hiding the answer would make every click after an agent edit a dead
    // end; the card shows the answer and says the positions may have moved.
    expect(result.ok && result.freshness).toBe('stale')
    expect(result.ok && result.symbol?.name).toBe('add')
  })

  test('a file type without an indexer answers null with no language', async () => {
    const result = await manager.symbolAt(projectRoot, { path: 'README.md', line: 0, character: 0 })
    expect(result).toEqual({ ok: true, symbol: null, language: null, freshness: 'fresh' })
  })

  test('host-only status lists every language with its install command', async () => {
    const status = await manager.status(null)
    expect(status.root).toBeNull()
    expect(status.languages.map((language) => language.language)).toEqual(['typescript', 'python', 'go', 'rust'])
    for (const language of status.languages) expect(language.installCommand.length).toBeGreaterThan(0)
  })

  test('a second manager adopts the cached index from disk without rebuilding', async () => {
    const second = new CodeIntelManager()
    try {
      const status = await second.status(projectRoot)
      const typescript = status.languages.find((language) => language.language === 'typescript')!
      expect(typescript.state).toBe('ready')
      expect(typescript.documentCount).toBe(2)
    } finally {
      second.dispose()
    }
  })
})
