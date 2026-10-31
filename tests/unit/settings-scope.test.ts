import { expect, test } from 'bun:test'
import { settingsProjectChoices, supportsProjectScope } from '@solus/workspace-ui/components/settings/lib/settings-scope'
import type { ProjectEntry } from '@solus/contracts/types'

test('only pages with project settings show a scope selector', () => {
  expect(supportsProjectScope('providers')).toBe(true)
  expect(supportsProjectScope('source-control')).toBe(true)
  expect(supportsProjectScope('appearance')).toBe(false)
  expect(supportsProjectScope('organization')).toBe(false)
})

test('a project deep link stays selected while the host list loads, and All projects is always available', () => {
  expect(settingsProjectChoices([], '/repo/app')).toEqual([{ value: '', label: 'All projects' }, { value: '/repo/app', label: 'app' }])
  const project: ProjectEntry = { key: 'app', path: '/repo/app', folderName: 'My app', addedAt: '', lastUsedAt: '', repositoryKey: null }
  expect(settingsProjectChoices([project], '/repo/app')).toEqual([{ value: '', label: 'All projects' }, { value: '/repo/app', label: 'My app' }])
})
