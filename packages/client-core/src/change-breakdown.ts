// Adapted from T3 Code packages/shared/src/changedFileKind.ts (MIT, see apps/mobile/UPSTREAM.md).
import type { ChangedFileStat } from '@solus/contracts/git-types'

/** What a changed file is, judged from its path alone. */
export type ChangeKind = 'code' | 'tests' | 'mocks' | 'generated' | 'docs'

/** One kind's share of a change. */
export interface ChangeBreakdownPart {
  kind: ChangeKind
  label: string
  additions: number
  deletions: number
}

/** The kinds in display order, with their labels. */
const KINDS = [
  { kind: 'code', label: 'Code' },
  { kind: 'tests', label: 'Tests' },
  { kind: 'mocks', label: 'Mocks' },
  { kind: 'generated', label: 'Generated' },
  { kind: 'docs', label: 'Docs' },
] as const satisfies readonly { kind: ChangeKind; label: string }[]

const GENERATED_FILES = new Set([
  'bun.lock', 'bun.lockb', 'cargo.lock', 'composer.lock', 'deno.lock', 'flake.lock', 'gemfile.lock',
  'go.sum', 'gradle.lockfile', 'mix.lock', 'npm-shrinkwrap.json', 'package-lock.json',
  'packages.lock.json', 'pipfile.lock', 'pnpm-lock.yaml', 'podfile.lock', 'poetry.lock',
  'pubspec.lock', 'uv.lock', 'yarn.lock',
])
const GENERATED_NAME =
  /(\.generated\.|\.gen\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.min\.(js|css)$|\.(js|css)\.map$)/
const GENERATED_DIRS = new Set(['__generated__', 'generated'])

const MOCK_NAME = /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/
const MOCK_DIRS = new Set(['__fixtures__', '__mocks__', '__snapshots__', 'fakes', 'fixture', 'fixtures', 'mock', 'mocks', 'stubs', 'testdata'])

const TEST_NAME = /(\.(test|spec|e2e)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i
// Case-sensitive: `FooTest.java` is a test class, `Latest.java` is not.
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/
const TEST_DIRS = new Set(['__tests__', '__test__', 'cypress', 'e2e', 'spec', 'specs', 'test', 'tests'])

const DOCS_NAME = /\.(md|mdx|markdown|rst|adoc|txt)$/i
// Plain-text files that tools read as config or input, not prose.
const NOT_DOCS_NAME = /^(requirements.*|constraints.*|CMakeLists|robots|llms)\.txt$/i

/**
 * Sorts a changed file by naming conventions. The first match wins:
 * lockfiles and build output are generated, test support (mocks, fixtures,
 * snapshots) is kept apart from the tests, and prose is docs, so a reviewer
 * sees how much of a change is logic.
 */
export function changedFileKind(path: string): ChangeKind {
  const segments = path.replaceAll('\\', '/').split('/')
  const name = segments.pop() ?? ''
  const dirs = segments.map((segment) => segment.toLowerCase())
  const inDir = (set: ReadonlySet<string>) => dirs.some((dir) => set.has(dir))
  if (GENERATED_FILES.has(name.toLowerCase()) || GENERATED_NAME.test(name) || inDir(GENERATED_DIRS)) return 'generated'
  if (MOCK_NAME.test(name) || inDir(MOCK_DIRS)) return 'mocks'
  if (TEST_NAME.test(name) || CLASS_TEST_NAME.test(name) || inDir(TEST_DIRS)) return 'tests'
  if (DOCS_NAME.test(name) && !NOT_DOCS_NAME.test(name)) return 'docs'
  return 'code'
}

/** Added and deleted lines of a whole change. */
export interface ChangeTotals {
  additions: number
  deletions: number
}

/**
 * A change's line counts split by kind, in display order, without the kinds
 * the change does not touch. Empty when every changed line is one kind: a
 * split with one part says nothing the total does not.
 *
 * `total` is the count shown beside the split. When the files do not add up
 * to it, the host gave only part of the files (GitHub stops at 3000), and a
 * split of part of the change would not match the total, so it is empty.
 */
export function changeBreakdown(files: readonly Pick<ChangedFileStat, 'path' | 'additions' | 'deletions'>[], total?: ChangeTotals): ChangeBreakdownPart[] {
  const fileKinds = files.map((file) => changedFileKind(file.path))
  const parts: ChangeBreakdownPart[] = []
  for (const { kind, label } of KINDS) {
    const part = { kind, label, additions: 0, deletions: 0 }
    files.forEach((file, index) => {
      if (fileKinds[index] !== kind) return
      part.additions += file.additions
      part.deletions += file.deletions
    })
    parts.push(part)
  }
  if (total) {
    const additions = parts.reduce((sum, part) => sum + part.additions, 0)
    const deletions = parts.reduce((sum, part) => sum + part.deletions, 0)
    if (additions !== total.additions || deletions !== total.deletions) return []
  }
  const touched = parts.filter((part) => part.additions + part.deletions > 0)
  return touched.length > 1 ? touched : []
}

/** The split as one line, such as `Code +120 −30 · Tests +80 −5`. */
export function changeBreakdownText(parts: readonly ChangeBreakdownPart[]): string {
  return parts.map((part) => `${part.label} +${part.additions.toLocaleString()} −${part.deletions.toLocaleString()}`).join(' · ')
}
