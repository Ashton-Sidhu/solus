import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configCommit, configRangeHint, configValueText, parseConfigDraft } from '@solus/client-core/app-config'
import { appConfigCallName, appDescriptorSchema, parseAppCallName, resolveAppConfig, type AppConfigField } from '@solus/contracts/apps'
import { AppStorage } from '@solus/server/apps/app-storage'
import { defineApp } from '../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app-backend'

/**
 * App config (docs/plans/apps.md §4.4): the settings an owner changes on the
 * Manage page, which the backend and the UI read. The service test
 * (`apps-service.test.ts`) runs a change through a real runner; these hold
 * the rules every side shares.
 */

const hour: AppConfigField = { name: 'hour', label: 'Hour', description: '', type: 'number', default: 9, min: 0, max: 23, integer: true }
const team: AppConfigField = { name: 'team', label: 'Team', description: '', type: 'choice', default: 'eng', options: [{ value: 'eng', label: 'Engineering' }, { value: 'ops', label: 'Operations' }] }

describe('the descriptor', () => {
  test('a template app\'s config is a descriptor Solus reads, with each field\'s defaults', () => {
    // WHY: the template and the host share no code. A field the contract
    // does not read is lost, and the Manage page shows nothing to change.
    const app = defineApp({
      name: 'Digest',
      config: {
        headline: { type: 'text', label: 'Headline', default: 'Hello', multiline: true },
        hour: { type: 'number', label: 'Hour', description: 'The hour of the digest.', default: 9, min: 0, max: 23, integer: true },
        loud: { type: 'boolean', label: 'Loud', default: false },
        team: { type: 'choice', label: 'Team', default: 'eng', options: [{ value: 'eng', label: 'Engineering' }] },
      },
    })
    expect(appDescriptorSchema.parse(app.descriptor()).config).toEqual([
      { name: 'headline', label: 'Headline', description: '', type: 'text', default: 'Hello', multiline: true },
      { name: 'hour', label: 'Hour', description: 'The hour of the digest.', type: 'number', default: 9, min: 0, max: 23, integer: true },
      { name: 'loud', label: 'Loud', description: '', type: 'boolean', default: false },
      { name: 'team', label: 'Team', description: '', type: 'choice', default: 'eng', options: [{ value: 'eng', label: 'Engineering' }] },
    ])
  })

  test('a default the field does not take fails the descriptor, so a deploy refuses it', () => {
    // WHY: the default is the value until the owner sets one. A default out
    // of range would run the app with a value its own field refuses.
    const app = defineApp({ name: 'Digest', config: { hour: { type: 'number', label: 'Hour', default: 30, max: 23 } } })
    expect(() => appDescriptorSchema.parse(app.descriptor())).toThrow('The default of hour is not one of its values: Hour is at most 23.')
  })

  test('a build from before config reads as an app with no config', () => {
    expect(appDescriptorSchema.parse({ solusApp: 2, name: 'Old' }).config).toEqual([])
  })
})

describe('the values the app runs with', () => {
  test('a stored value the field still takes is used; one it no longer takes gives the default', () => {
    // WHY: a new version can narrow a field. The owner's old value must not
    // reach code that was written for the new range.
    expect(resolveAppConfig([hour, team], { hour: 7, team: 'ops' })).toEqual({ hour: 7, team: 'ops' })
    expect(resolveAppConfig([hour, team], { hour: 30, team: 'sales' })).toEqual({ hour: 9, team: 'eng' })
    expect(resolveAppConfig([hour], { hour: 7.5 })).toEqual({ hour: 9 })
    // A value of a field the version no longer declares is not given to the app.
    expect(resolveAppConfig([hour], { gone: 'x' })).toEqual({ hour: 9 })
  })

  test('the UI reads the config by its own call name', () => {
    expect(parseAppCallName(appConfigCallName('get'))).toEqual({ kind: 'config', operation: 'get' })
    expect(parseAppCallName('@config/set')).toBeNull()
  })
})

describe('the Manage page', () => {
  test('a number draft is a number the field takes, or a sentence that says why not', () => {
    expect(parseConfigDraft(hour, '7')).toEqual({ value: 7, problem: null })
    expect(parseConfigDraft(hour, '')).toEqual({ value: null, problem: 'Hour takes a number.' })
    expect(parseConfigDraft(hour, 'seven')).toEqual({ value: null, problem: 'Hour takes a number.' })
    expect(parseConfigDraft(hour, '7.5')).toEqual({ value: null, problem: 'Hour takes a whole number.' })
    expect(parseConfigDraft(hour, '24')).toEqual({ value: null, problem: 'Hour is at most 23.' })
    expect(configRangeHint(hour)).toBe('A whole number from 0 to 23.')
  })

  test('leaving a field saves only a new value the field takes', () => {
    // WHY: a field saves when the owner leaves it. Leaving an untouched field
    // must not write the value again, and a value the field refuses must stay
    // in the field with its problem rather than be sent to the host.
    const current = { ...hour, value: 7, isDefault: false }
    expect(configCommit(current, '8')).toEqual({ kind: 'save', value: 8 })
    expect(configCommit(current, '7')).toEqual({ kind: 'unchanged' })
    expect(configCommit(current, ' 7 ')).toEqual({ kind: 'unchanged' })
    expect(configCommit(current, '24')).toEqual({ kind: 'invalid', problem: 'Hour is at most 23.' })
  })

  test('a value reads as the owner says it', () => {
    expect(configValueText(team, 'ops')).toBe('Operations')
    expect(configValueText({ name: 'loud', label: 'Loud', description: '', type: 'boolean', default: false }, true)).toBe('On')
    expect(configValueText({ name: 'model', label: 'Model', description: '', type: 'model', default: '' }, '')).toBe('Solus default')
    expect(configValueText({ name: 'note', label: 'Note', description: '', type: 'text', default: '', multiline: false }, '')).toBe('Empty')
  })
})

describe('the stored values', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test('the values are kept apart from the app\'s storage, and deleting the app removes them', async () => {
    // WHY: config.json and storage.json are in one folder. A config write
    // must not change what the app's UI keeps, and a deleted app keeps nothing.
    const root = mkdtempSync(join(tmpdir(), 'solus-app-config-'))
    roots.push(root)
    const storage = new AppStorage(() => root)
    await storage.set('app1', 'view', { sort: 'new' })
    await storage.setConfig('app1', 'hour', 7)
    await storage.setConfig('app1', 'team', 'ops')
    await storage.setConfig('app1', 'team', null)
    expect(await storage.config('app1')).toEqual({ hour: 7 })
    expect(await storage.keys('app1')).toEqual(['view'])
    expect(await storage.config('other')).toEqual({})
    await storage.remove('app1')
    expect(await storage.config('app1')).toEqual({})
  })
})
