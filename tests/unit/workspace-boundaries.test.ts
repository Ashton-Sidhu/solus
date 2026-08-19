import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, normalize, relative, resolve, sep } from 'path'

type SourceOwner = 'contracts' | 'server' | 'client-core' | 'workspace-ui' | 'app'

interface SourceRoot {
  owner: SourceOwner
  path: string
  appName?: string
}

interface ImportReference {
  sourcePath: string
  importedPath: string
}

const SOURCE_EXTENSIONS = ['.ts', '.svelte.ts', '.svelte']
const IMPORT_REFERENCE =
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)|\b(?:import(?:\s+type)?[\s\S]*?\bfrom|export(?:\s+type)?[\s\S]*?\bfrom)\s*['"]([^'"]+)['"]/g

const SOURCE_ROOTS: SourceRoot[] = [
  { owner: 'contracts', path: 'packages/contracts/src' },
  { owner: 'server', path: 'packages/server/src' },
  { owner: 'client-core', path: 'packages/client-core/src' },
  { owner: 'workspace-ui', path: 'packages/workspace-ui/src' },
  { owner: 'app', path: 'apps/desktop/src', appName: 'desktop' },
  { owner: 'app', path: 'apps/standalone-server/src', appName: 'standalone-server' },
  { owner: 'app', path: 'apps/client/src', appName: 'client' },
  { owner: 'app', path: 'apps/site/src', appName: 'site' },
  { owner: 'app', path: 'apps/cli/src', appName: 'cli' },
]

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
}

function listSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []

  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
    } else if (isSourceFile(path)) {
      files.push(path)
    }
  }
  return files
}

function importReferences(sourcePath: string, source: string): ImportReference[] {
  const references: ImportReference[] = []
  IMPORT_REFERENCE.lastIndex = 0

  for (const match of source.matchAll(IMPORT_REFERENCE)) {
    references.push({ sourcePath, importedPath: match[1] ?? match[2] })
  }
  return references
}

function normalizedRepositoryPath(path: string): string {
  return normalize(path).split(sep).join('/')
}

function ownerForRepositoryPath(path: string): SourceRoot | undefined {
  const normalizedPath = normalizedRepositoryPath(path)
  return SOURCE_ROOTS.find(
    (root) => normalizedPath === root.path || normalizedPath.startsWith(`${root.path}/`),
  )
}

function importedOwner(sourcePath: string, importedPath: string): SourceRoot | undefined {
  const packageRoot = importedPath.match(/^@solus\/(contracts|server|client-core|workspace-ui)(?:\/|$)/)?.[1]
  if (packageRoot) {
    return { owner: packageRoot as Exclude<SourceOwner, 'app'>, path: `packages/${packageRoot}/src` }
  }

  if (importedPath === 'electron') return { owner: 'app', path: 'electron', appName: 'desktop' }

  if (importedPath.startsWith('.')) {
    return ownerForRepositoryPath(
      normalizedRepositoryPath(relative(process.cwd(), resolve(dirname(sourcePath), importedPath))),
    )
  }

  return undefined
}

function boundaryViolation(sourceRoot: SourceRoot, sourcePath: string, importedPath: string): string | undefined {
  const targetRoot = importedOwner(sourcePath, importedPath)
  if (!targetRoot) return undefined

  if (
    importedPath.startsWith('.') &&
    sourceRoot.path.startsWith('packages/') &&
    targetRoot.path !== sourceRoot.path
  ) {
    return 'relative import escapes package source'
  }

  if (sourceRoot.owner === 'contracts' && targetRoot.owner !== 'contracts') {
    return 'contracts import another owner'
  }

  if (
    sourceRoot.owner === 'server' &&
    (targetRoot.owner === 'app' ||
      targetRoot.owner === 'client-core' ||
      targetRoot.owner === 'workspace-ui')
  ) {
    return 'server imports client or app code'
  }

  if (
    sourceRoot.owner === 'client-core' &&
    (targetRoot.owner === 'app' || targetRoot.owner === 'server' || targetRoot.owner === 'workspace-ui')
  ) {
    return 'client-core imports server, UI, or app code'
  }

  if (
    sourceRoot.owner === 'workspace-ui' &&
    (targetRoot.owner === 'app' || targetRoot.owner === 'server')
  ) {
    return 'workspace-ui imports server or app code'
  }

  if (
    sourceRoot.owner === 'app' &&
    targetRoot.owner === 'app' &&
    sourceRoot.appName !== targetRoot.appName
  ) {
    return 'one app imports another app'
  }

  return undefined
}

function findViolations(root: SourceRoot, files: string[]): string[] {
  return files.flatMap((sourcePath) => {
    const source = readFileSync(sourcePath, 'utf8')
    return importReferences(sourcePath, source).flatMap(({ importedPath }) => {
      const reason = boundaryViolation(root, sourcePath, importedPath)
      return reason ? [`${normalizedRepositoryPath(relative(process.cwd(), sourcePath))}: ${importedPath} (${reason})`] : []
    })
  })
}

describe('workspace dependency boundaries', () => {
  test('detects static imports, dynamic imports, and re-exports', () => {
    expect(
      importReferences(
        '/repo/packages/server/src/example.ts',
        [
          "import value from '@solus/contracts/value'",
          "const lazy = import('@solus/workspace-ui/lazy')",
          "export { other } from '@solus/client-core/other'",
        ].join('\n'),
      ).map(({ importedPath }) => importedPath),
    ).toEqual([
      '@solus/contracts/value',
      '@solus/workspace-ui/lazy',
      '@solus/client-core/other',
    ])
  })

  test('discovers TypeScript and Svelte source extensions', () => {
    expect(['a.ts', 'a.svelte.ts', 'a.svelte'].filter(isSourceFile)).toEqual([
      'a.ts',
      'a.svelte.ts',
      'a.svelte',
    ])
  })

  test('allows the declared package graph', () => {
    const clientCore = SOURCE_ROOTS[2]
    const workspaceUi = SOURCE_ROOTS[3]
    expect(boundaryViolation(clientCore, '/repo/packages/client-core/src/api.ts', '@solus/contracts/rpc')).toBeUndefined()
    expect(boundaryViolation(workspaceUi, '/repo/packages/workspace-ui/src/store.ts', '@solus/client-core/api')).toBeUndefined()
  })

  test('rejects every forbidden package and app edge', () => {
    const contracts = SOURCE_ROOTS[0]
    const server = SOURCE_ROOTS[1]
    const clientCore = SOURCE_ROOTS[2]
    const workspaceUi = SOURCE_ROOTS[3]
    const desktop = SOURCE_ROOTS[4]
    const client = SOURCE_ROOTS[6]

    expect(boundaryViolation(contracts, '/repo/packages/contracts/src/a.ts', '@solus/server/a')).toBeTruthy()
    expect(boundaryViolation(server, '/repo/packages/server/src/a.ts', '@solus/client-core/a')).toBeTruthy()
    expect(boundaryViolation(server, '/repo/packages/server/src/a.ts', 'electron')).toBeTruthy()
    expect(boundaryViolation(clientCore, '/repo/packages/client-core/src/a.ts', '@solus/workspace-ui/a')).toBeTruthy()
    expect(boundaryViolation(workspaceUi, '/repo/packages/workspace-ui/src/a.ts', '@solus/server/a')).toBeTruthy()
    expect(
      boundaryViolation(
        desktop,
        join(process.cwd(), 'apps/desktop/src/a.ts'),
        '../../client/src/a',
      ),
    ).toBeTruthy()
    expect(
      boundaryViolation(
        client,
        join(process.cwd(), 'apps/client/src/a.ts'),
        '../../desktop/src/a',
      ),
    ).toBeTruthy()
  })

  test('reports the source and imported path', () => {
    const server = SOURCE_ROOTS[1]
    const sourcePath = join(process.cwd(), 'packages/server/src/example.ts')
    const violation = boundaryViolation(server, sourcePath, '@solus/workspace-ui/example')
    expect(`${normalizedRepositoryPath(relative(process.cwd(), sourcePath))}: @solus/workspace-ui/example (${violation})`).toContain(
      'packages/server/src/example.ts: @solus/workspace-ui/example',
    )
  })

  test('source roots follow the declared graph', () => {
    const offenders = SOURCE_ROOTS.flatMap((root) => {
      const directory = join(process.cwd(), root.path)
      return findViolations(root, listSourceFiles(directory))
    })

    expect(offenders).toEqual([])
  })
})
