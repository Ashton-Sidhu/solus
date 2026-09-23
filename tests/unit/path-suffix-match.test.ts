import { describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { IpcContext } from '@solus/contracts/types'

// The index is the project's own; what it holds is the test's subject, so each
// test declares the file list its project would have been scanned into. The
// glob stands in for fff's `**/<literal>`: a whole-segment suffix match.
let indexed: string[] = []
mock.module('@ff-labs/fff-node', () => ({
  FileFinder: {
    create: () => ({
      ok: true,
      value: {
        waitForScan: async () => {},
        destroy: () => {},
        glob: (pattern: string, options?: { pageSize?: number }) => {
          const target = pattern.replace(/^\*\*\//, '').replace(/\\(.)/g, '$1')
          const matched = indexed.filter(path => path === target || path.endsWith(`/${target}`))
          return {
            ok: true,
            value: {
              items: matched.slice(0, options?.pageSize ?? 100).map(relativePath => ({ relativePath })),
              totalMatched: matched.length,
            },
          }
        },
      },
    }),
  },
}))

const { requestedRelativePath } = await import('@solus/server/server/handlers/lib/path-suffix-match')
const { readFilePreview } = await import('@solus/server/server/handlers/lib/file-preview')

describe('a partial path', () => {
  test('is not looked for when the path already says where it lives', () => {
    expect(requestedRelativePath('/Users/dev/project/lib/paths.ts')).toBeNull()
    expect(requestedRelativePath('~/project/lib/paths.ts')).toBeNull()
    expect(requestedRelativePath('../other/lib/paths.ts')).toBeNull()
  })

  test('is read through separators and a leading dot segment', () => {
    expect(requestedRelativePath('./lib/paths.ts')).toBe('lib/paths.ts')
    expect(requestedRelativePath('lib\\paths.ts')).toBe('lib/paths.ts')
  })
})

describe('previewing a file an agent named by a partial path', () => {
  async function withProject(
    files: string[],
    run: (root: string, ctx: IpcContext) => Promise<void>,
  ): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'solus-partial-path-')))
    try {
      for (const file of files) {
        await mkdir(dirname(join(root, file)), { recursive: true })
        await writeFile(join(root, file), `// ${file}\n`)
      }
      indexed = files
      await run(root, { session: { sessionId: 's', workingDirectory: root, projectPath: root } } as IpcContext)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test('opens the real file a unique partial path names', () =>
    withProject(['packages/ui/src/lib/paths.ts'], async (root, ctx) => {
      expect(await readFilePreview(ctx, { path: 'lib/paths.ts', cwd: root })).toMatchObject({
        ok: true,
        path: join(root, 'packages/ui/src/lib/paths.ts'),
        displayPath: 'packages/ui/src/lib/paths.ts',
        contents: '// packages/ui/src/lib/paths.ts\n',
      })
    }))

  test('reports the miss rather than opening one of two candidates', () =>
    withProject(['a/lib/paths.ts', 'b/lib/paths.ts'], async (root, ctx) => {
      const result = await readFilePreview(ctx, { path: 'lib/paths.ts', cwd: root })
      expect(result.ok).toBe(false)
      expect(result.path).toBe(join(root, 'lib/paths.ts'))
    }))

  test('opens a route segment by its literal name', () =>
    withProject(['src/app/[id]/page.tsx'], async (root, ctx) => {
      expect(await readFilePreview(ctx, { path: 'app/[id]/page.tsx', cwd: root })).toMatchObject({
        ok: true,
        displayPath: 'src/app/[id]/page.tsx',
      })
    }))

  test('leaves a path that resolves literally alone', () =>
    withProject(['lib/paths.ts', 'deep/lib/paths.ts'], async (root, ctx) => {
      expect(await readFilePreview(ctx, { path: 'lib/paths.ts', cwd: root })).toMatchObject({
        ok: true,
        displayPath: 'lib/paths.ts',
      })
    }))
})
