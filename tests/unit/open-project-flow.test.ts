import { describe, expect, test } from 'bun:test'
import { joinHostPath } from '@solus/workspace-ui/components/servers/lib/open-project-flow'

describe('open project path math', () => {
  test('a clone destination is built with the target host separator, not this one', () => {
    expect(joinHostPath('/home/dev/projects', 'solus', 'linux')).toBe('/home/dev/projects/solus')
    expect(joinHostPath('C:\\Users\\dev\\projects', 'solus', 'win32')).toBe('C:\\Users\\dev\\projects\\solus')
  })

  test('a trailing separator on the root never doubles up', () => {
    expect(joinHostPath('/home/dev/', 'solus', 'darwin')).toBe('/home/dev/solus')
  })
})
