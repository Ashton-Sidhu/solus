import { describe, expect, mock, test } from 'bun:test'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'

// The picker shows each app by its logo, as T3 Code's does. An app added to the
// catalog with no logo would show a bare letter among logos: a person notices.
for (const name of ['chatgpt', 'claude', 'codex', 'cursor', 'grokbot', 'hermes', 'instinct', 'muse', 'openclaw', 'poke']) {
  mock.module(`../../packages/workspace-ui/src/components/connections/outside-apps/logos/${name}.png`, () => ({ default: `${name}.png` }))
}
const { outsideAppLogo } = await import('@solus/workspace-ui/components/connections/outside-apps/outside-app-logos')

describe('the logos of the outside app picker', () => {
  test('every app in the catalog has a logo', () => {
    expect(OUTSIDE_APP_GUIDES.filter((guide) => !outsideAppLogo(guide.id)).map((guide) => guide.id)).toEqual([])
  })

  test('a white mark gets the dark tile, a full logo does not', () => {
    expect(outsideAppLogo('cursor')?.onDark).toBe(true)
    expect(outsideAppLogo('codex')?.onDark).toBe(true)
    expect(outsideAppLogo('claude')?.onDark).toBe(false)
  })

  test('an app Solus does not know shows a letter instead', () => {
    expect(outsideAppLogo('something-new')).toBeNull()
  })
})
