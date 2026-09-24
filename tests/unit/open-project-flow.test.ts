import { describe, expect, test } from 'bun:test'
import { joinHostPath, newProjectPath } from '@solus/workspace-ui/components/servers/lib/open-project-flow'

describe('open project path math', () => {
  test('a clone destination is built with the target host separator, not this one', () => {
    expect(joinHostPath('/home/dev/projects', 'solus', 'linux')).toBe('/home/dev/projects/solus')
    expect(joinHostPath('C:\\Users\\dev\\projects', 'solus', 'win32')).toBe('C:\\Users\\dev\\projects\\solus')
  })

  test('a trailing separator on the root never doubles up', () => {
    expect(joinHostPath('/home/dev/', 'solus', 'darwin')).toBe('/home/dev/solus')
  })

  test('the new-project preview is the path the host creates, and nothing before a name', () => {
    // WHY: the dialog and onboarding show this path before Create. It must be
    // the folder the host names, or the user reads one path and gets another.
    expect(newProjectPath('/home/dev/projects', 'My Website', 'linux')).toBe('/home/dev/projects/My-Website')
    expect(newProjectPath('C:\\Users\\dev\\projects', 'site', 'win32')).toBe('C:\\Users\\dev\\projects\\site')
    expect(newProjectPath('/home/dev/projects', '   ', 'linux')).toBeNull()
  })
})
