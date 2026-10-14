import { describe, expect, test } from 'bun:test'
import { fileManagerNameFor } from '../../packages/workspace-ui/src/lib/file-manager'

// "Open in …" names the file manager the host reports, so a Windows user never
// reads "Finder".
describe('fileManagerNameFor', () => {
  test.each([
    ['finder', 'Finder'],
    ['file-explorer', 'File Explorer'],
    ['files', 'Files'],
  ] as const)('names %s', (kind, name) => {
    expect(fileManagerNameFor(kind)).toBe(name)
  })
})
