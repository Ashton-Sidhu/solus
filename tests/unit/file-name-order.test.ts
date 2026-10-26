import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browseFileMatches } from '@solus/server/files/file-browse'
import { compareFileNames } from '@solus/server/files/name-order'
import { addTreePath } from '@solus/workspace-ui/components/files/lib/file-tree-mutations'

// The host's listings and the client's tree insert must agree on one order,
// or a refresh reshuffles rows the client already placed.
const names = ['file10.ts', 'File2.ts', 'file1.ts', 'b.ts', 'B.ts', 'a10', 'a9', 'ä.ts', 'a.ts', '_x', '10', '9']

function localeOrder(values: string[]): string[] {
  return values.slice().sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
}

describe('file name order', () => {
  test('numbers sort by value and case does not split a name from its twin', () => {
    expect(['file10.ts', 'File2.ts', 'file1.ts'].sort(compareFileNames)).toEqual(['file1.ts', 'File2.ts', 'file10.ts'])
    // Names equal under base sensitivity keep their input order (stable sort).
    expect(['b.ts', 'B.ts'].sort(compareFileNames)).toEqual(['b.ts', 'B.ts'])
    expect(['B.ts', 'b.ts'].sort(compareFileNames)).toEqual(['B.ts', 'b.ts'])
  })

  test('the shared collator orders exactly as localeCompare with the same options', () => {
    expect(names.slice().sort(compareFileNames)).toEqual(localeOrder(names))
  })

  test('path browsing lists folders first, each group in name order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solus-name-order-'))
    try {
      await mkdir(join(directory, 'dir10'))
      await mkdir(join(directory, 'Dir9'))
      for (const name of ['file10.ts', 'File2.ts', 'file1.ts']) await writeFile(join(directory, name), '')
      const matches = await browseFileMatches(`${directory}/`, directory)
      expect(matches?.map((match) => match.display)).toEqual(['Dir9', 'dir10', 'file1.ts', 'File2.ts', 'file10.ts'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the client tree inserts a path where the host order puts it', () => {
    const paths = localeOrder(['src/file1.ts', 'src/file10.ts', 'src/File3.ts'])
    addTreePath(paths, 'src/file2.ts')
    expect(paths).toEqual(['src/file1.ts', 'src/file2.ts', 'src/File3.ts', 'src/file10.ts'])
  })
})
