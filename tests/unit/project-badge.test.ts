import { describe, expect, it } from 'bun:test'
import { projectBadgeColors, projectBadgeHue, projectInitials } from '@solus/contracts/project-badge'

describe('project badge', () => {
  it('names a project by its first two words, or the first two letters of one word', () => {
    expect(projectInitials('ts-rust')).toBe('TR')
    expect(projectInitials('my_web app')).toBe('MW')
    expect(projectInitials('solus')).toBe('SO')
    expect(projectInitials('x')).toBe('X')
  })

  it('has no initials for a name with no letters, so the folder icon stays', () => {
    expect(projectInitials('---')).toBe('')
    expect(projectInitials('')).toBe('')
  })

  it('gives one project the same colour on every client and in every place', () => {
    expect(projectBadgeHue('solus')).toBe(projectBadgeHue('solus'))
    expect(projectBadgeColors('solus', 'dark')).toEqual(projectBadgeColors('solus', 'dark'))
  })

  it('tells different projects apart by colour', () => {
    const hues = new Set(['solus', 'ts-rust', 'plop', 'draft', 't3code', 'site'].map(projectBadgeHue))
    expect(hues.size).toBeGreaterThanOrEqual(5)
  })

  it('has a tint and ink for light and for dark mode', () => {
    const light = projectBadgeColors('solus', 'light')
    const dark = projectBadgeColors('solus', 'dark')
    expect(light.background).not.toBe(dark.background)
    expect(light.foreground).not.toBe(dark.foreground)
  })
})
