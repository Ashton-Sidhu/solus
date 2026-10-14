import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { splitPatchByFile } from '../../packages/workspace-ui/src/components/pr-review/guide/lib/guide-data'
import { extractChangedFilePathsFromMessage } from '../../packages/workspace-ui/src/lib/changedFiles'
import { parsePatchMetadata } from '../../packages/workspace-ui/src/lib/pierre-diff'

// Every client reads a patch with the @pierre/diffs parser. These are the
// headers the old `diff --git a/(.+) b/(.+)` regex read wrong.

const QUOTED = [
  'diff --git "a/docs/caf\\303\\251 menu.md" "b/docs/caf\\303\\251 menu.md"',
  'index 1111111..2222222 100644',
  '--- "a/docs/caf\\303\\251 menu.md"',
  '+++ "b/docs/caf\\303\\251 menu.md"',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n')

const B_IN_PATH = [
  'diff --git a/src/a b/c.ts b/src/a b/c.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a b/c.ts',
  '+++ b/src/a b/c.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n')

const RENAMES = [
  'diff --git a/src/old.ts b/src/new.ts',
  'similarity index 90%',
  'rename from src/old.ts',
  'rename to src/new.ts',
  '--- a/src/old.ts',
  '+++ b/src/new.ts',
  '@@ -1 +1 @@',
  '-a',
  '\\ No newline at end of file',
  '+b',
  '\\ No newline at end of file',
  'diff --git "a/caf\\303\\251.ts" "b/men\\303\\274.ts"',
  'similarity index 100%',
  'rename from "caf\\303\\251.ts"',
  'rename to "men\\303\\274.ts"',
  '',
].join('\n')

const DELETED = [
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 1111111..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  '',
].join('\n')

describe('guide patch segments', () => {
  test('each file is keyed by its real post-image path and renders alone', () => {
    // WHY: a guide section finds its diff by the file path. A quoted, renamed,
    // or ` b/` path that is keyed wrong shows a section with no diff.
    const segments = splitPatchByFile(QUOTED + B_IN_PATH + RENAMES + DELETED)
    expect([...segments.keys()]).toEqual(['docs/café menu.md', 'src/a b/c.ts', 'src/new.ts', 'menü.ts', 'src/gone.ts'])
    expect(segments.get('src/a b/c.ts')).toBe(B_IN_PATH)
    expect(segments.get('src/gone.ts')).toBe(DELETED)
    // A segment is a valid single-file patch, and its no-newline marker is not a line.
    const renamed = parsePatchMetadata(segments.get('src/new.ts')!)
    expect(renamed?.hunks[0]?.additionCount).toBe(1)
    expect(renamed?.additionLines).toEqual(['b'])
  })

  test('an empty patch has no segments', () => {
    expect(splitPatchByFile('').size).toBe(0)
  })
})

describe('changed files from command output', () => {
  const output = (content: string): Message => ({
    id: 'tool-1',
    role: 'tool',
    content,
    timestamp: 0,
    toolName: 'exec_command',
    toolStatus: 'completed',
    toolInput: JSON.stringify({ cmd: 'cat change.patch' }),
  })

  test('a diff in the output names each file by its real path', () => {
    expect(extractChangedFilePathsFromMessage(output(`Applying:\n${QUOTED}${B_IN_PATH}${RENAMES}${DELETED}done\n`)))
      .toEqual(['docs/café menu.md', 'src/a b/c.ts', 'src/new.ts', 'menü.ts', 'src/gone.ts'])
  })

  test('output with no diff, or prose that names diff --git, adds no path', () => {
    expect(extractChangedFilePathsFromMessage(output('All 12 tests pass\n'))).toEqual([])
    expect(extractChangedFilePathsFromMessage(output('Run diff --git to compare\ndiff --git is a command\n'))).toEqual([])
  })
})
