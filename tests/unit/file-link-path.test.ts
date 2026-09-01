import { describe, expect, test } from 'bun:test'
import { fileLinkTooltip } from '@solus/workspace-ui/components/conversation/lib/file-link-path'

const CWD = '/Users/dev/Projects/solus'

describe('file link tooltips', () => {
  test('states the whole path when the agent wrote a relative one', () => {
    // The chip's label is usually this same string, so a tooltip that repeated
    // it would tell the reader nothing about which checkout is meant.
    expect(fileLinkTooltip('src/main.ts', undefined, CWD)).toBe('/Users/dev/Projects/solus/src/main.ts')
  })

  test('keeps the line number on the resolved path', () => {
    expect(fileLinkTooltip('src/main.ts', 42, CWD)).toBe('/Users/dev/Projects/solus/src/main.ts:42')
  })

  test('leaves an already-absolute path alone', () => {
    expect(fileLinkTooltip('/etc/hosts', undefined, CWD)).toBe('/etc/hosts')
    expect(fileLinkTooltip('~/notes.md', undefined, CWD)).toBe('~/notes.md')
    expect(fileLinkTooltip('C:/Users/dev/main.ts', undefined, CWD)).toBe('C:/Users/dev/main.ts')
  })

  test('a session with no directory of its own resolves nothing', () => {
    expect(fileLinkTooltip('src/main.ts', undefined, undefined)).toBe('src/main.ts')
    expect(fileLinkTooltip('src/main.ts', undefined, '~')).toBe('src/main.ts')
  })

  test('joins a Windows working directory with its own separator', () => {
    expect(fileLinkTooltip('src\\main.ts', undefined, 'C:\\Users\\dev\\solus'))
      .toBe('C:\\Users\\dev\\solus\\src\\main.ts')
  })

  test('a dot-slash prefix does not survive into the resolved path', () => {
    expect(fileLinkTooltip('./src/main.ts', undefined, CWD)).toBe('/Users/dev/Projects/solus/src/main.ts')
  })
})
