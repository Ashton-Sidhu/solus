import { describe, expect, test } from 'bun:test'
import { HostPolicies } from '@solus/contracts/host-policies'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'
import type { PolicyDocument, PolicySet } from '@solus/contracts/policy'
import {
  openOutsideApp,
  outsideAppAction,
  outsideAppAddress,
  outsideAppChoices,
  outsideAppFallbackLink,
  type LinkOpener,
} from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { allowedOutsideApps, toggledOutsideApp, withAllowedOutsideApps } from '@solus/workspace-ui/components/settings/policy/lib/policy-outside-apps'
import { outsideAppLinkUrl } from '../../apps/desktop/src/main/outside-app-links'

// The outside app picker on a host's Access tab (plans/035 §10). What a person
// would notice going wrong: a cloud app sent to a localhost address it cannot
// reach, an action that opens the app before the clipboard holds the address,
// an app their organization forbids that looks allowed, and a desktop that
// refuses the app links the guides make or lets other deep links through.

const LOCAL_ONLY = { localUrl: 'http://localhost:4810/mcp', publicUrl: null }
const WITH_TUNNEL = { localUrl: 'http://localhost:4810/mcp', publicUrl: 'https://box.solus.dev/mcp' }

function guide(id: string): OutsideAppGuide {
  const found = OUTSIDE_APP_GUIDES.find((entry) => entry.id === id)
  if (!found) throw new Error(`No guide ${id}`)
  return found
}

describe('the address an app gets', () => {
  test('a cloud app gets only the public address, and none on a host without one', () => {
    expect(outsideAppAddress(guide('chatgpt'), WITH_TUNNEL)).toBe('https://box.solus.dev/mcp')
    expect(outsideAppAddress(guide('chatgpt'), LOCAL_ONLY)).toBeNull()
  })

  test('an app on a computer gets the public address when there is one, else the local one', () => {
    expect(outsideAppAddress(guide('cursor'), WITH_TUNNEL)).toBe('https://box.solus.dev/mcp')
    expect(outsideAppAddress(guide('claude-code'), LOCAL_ONLY)).toBe('http://localhost:4810/mcp')
  })
})

describe('the primary action of each handoff', () => {
  const url = 'https://box.solus.dev/mcp'

  test('Claude opens its add form with the address filled in, and copies nothing', () => {
    const action = outsideAppAction(guide('claude'), url)
    if (action.kind !== 'open') throw new Error('expected open')
    expect(action.copy).toBeNull()
    expect(action.link).toContain(`connectorUrl=${encodeURIComponent(url)}`)
  })

  test('ChatGPT copies the address, then opens its page', () => {
    const action = outsideAppAction(guide('chatgpt'), url)
    if (action.kind !== 'open') throw new Error('expected open')
    expect(action.copy?.text).toBe(url)
    expect(action.link).toBe('https://chatgpt.com/plugins')
    expect(action.appLink).toBeNull()
  })

  test('Grok Bot copies a message with the address, and tries its app with that message first', () => {
    const action = outsideAppAction(guide('grok-bot'), url)
    if (action.kind !== 'open') throw new Error('expected open')
    expect(action.copy?.text).toContain(url)
    expect(action.appLink).toBe(`grokbot://app/v1/prompt?text=${encodeURIComponent(action.copy?.text ?? '')}`)
    expect(action.link).toBe('https://x.ai/bot')
  })

  test('Codex gives its commands with the address', () => {
    expect(outsideAppAction(guide('codex'), url)).toEqual({ kind: 'commands', commands: [`codex mcp add solus --url ${url}`, 'codex mcp login solus'] })
  })
})

describe('opening an app', () => {
  function opener(isWeb: boolean, opens: (url: string) => boolean) {
    const opened: string[] = []
    const assigned: string[] = []
    const value: LinkOpener = {
      isWeb,
      openExternal: async (target) => {
        opened.push(target)
        return opens(target)
      },
      assign: (target) => { assigned.push(target) },
    }
    return { value, opened, assigned }
  }
  const grok = { link: 'https://x.ai/bot', appLink: 'grokbot://app/v1/prompt?text=hi' }

  test('the desktop app falls back to the page when nothing opens the app link', async () => {
    const desktop = opener(false, (target) => target.startsWith('https:'))
    expect(await openOutsideApp(grok, desktop.value)).toBe(true)
    expect(desktop.opened).toEqual([grok.appLink, grok.link])
  })

  test('the desktop app stops at the app link when it opens', async () => {
    const desktop = opener(false, () => true)
    await openOutsideApp(grok, desktop.value)
    expect(desktop.opened).toEqual([grok.appLink])
  })

  test('a browser goes to an app link in place, not in a blank tab, and keeps the page within reach', async () => {
    const web = opener(true, () => true)
    expect(await openOutsideApp(grok, web.value)).toBe(true)
    expect(web.assigned).toEqual([grok.appLink])
    expect(web.opened).toEqual([])
    expect(outsideAppFallbackLink({ ...grok, copy: { text: 'hi', done: '' } }, true)).toBe(grok.link)
  })

  test('a page that opens on the desktop needs no fallback', () => {
    expect(outsideAppFallbackLink({ link: 'https://chatgpt.com/plugins', appLink: null, copy: { text: 'x', done: '' } }, false)).toBeNull()
  })

  test('says when nothing opened', async () => {
    const desktop = opener(false, () => false)
    expect(await openOutsideApp({ link: 'https://x.ai/bot', appLink: null }, desktop.value)).toBe(false)
  })
})

describe('apps an organization allows', () => {
  function choicesFor(allowed: PolicyDocument['sessions'] | undefined) {
    const policy: PolicySet = {
      mdm: null,
      hostOwnerOrganizationId: null,
      organizations: { acme: { state: 'ready', hostPolicy: null, policy: { kind: 'organization', organizationId: 'acme', document: { schemaVersion: 1, organization: { name: 'Acme' }, sessions: allowed } } } },
    }
    return outsideAppChoices(new HostPolicies(policy).forWork('acme'))
  }

  test('with no rule every app is allowed', () => {
    expect(choicesFor(undefined).every((choice) => choice.denial === null)).toBe(true)
  })

  test('a rule marks the apps it does not name, and both guides of apps on the computer follow `local`', () => {
    const choices = choicesFor({ limits: { apps: { allowed: ['claude', 'local'] } } })
    const denied = choices.filter((choice) => choice.denial).map((choice) => choice.guide.id)
    expect(denied).toEqual(['chatgpt', 'grok-bot', 'poke', 'cursor'])
    expect(choices.find((choice) => choice.guide.id === 'poke')?.denial).toBe('Acme does not allow Poke to use Solus.')
  })
})

describe('the desktop app links it opens', () => {
  test('takes the Grok Bot prompt and the Cursor MCP settings links the guides make', () => {
    const grokLink = outsideAppAction(guide('grok-bot'), 'https://box.solus.dev/mcp')
    if (grokLink.kind !== 'open' || !grokLink.appLink) throw new Error('expected an app link')
    expect(outsideAppLinkUrl(grokLink.appLink)).toBe(grokLink.appLink)
    expect(outsideAppLinkUrl('cursor://anysphere.cursor-deeplink/settings/mcp')).toBe('cursor://anysphere.cursor-deeplink/settings/mcp')
  })

  test('refuses other deep links of the same apps', () => {
    expect(outsideAppLinkUrl('grokbot://app/v1/run?text=hi')).toBeNull()
    expect(outsideAppLinkUrl('grokbot://app/v1/prompt?text=hi&auto=1')).toBeNull()
    expect(outsideAppLinkUrl('grokbot://evil/v1/prompt?text=hi')).toBeNull()
    expect(outsideAppLinkUrl('cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=e30')).toBeNull()
    expect(outsideAppLinkUrl('cursor://anysphere.cursor-deeplink/settings/mcp?x=1')).toBeNull()
    expect(outsideAppLinkUrl('poke://anything')).toBeNull()
  })
})

describe('the Outside apps limit in the policy editor', () => {
  const base: PolicyDocument = { schemaVersion: 1, organization: { name: 'Acme' }, sessions: { limits: { maxPermissionMode: 'auto' } } }

  test('All apps is the default: the key is not set', () => {
    expect(allowedOutsideApps(base)).toBeNull()
  })

  test('choosing apps writes sessions.limits.apps.allowed, in a stable order, and keeps the other limits', () => {
    const chosen = withAllowedOutsideApps(base, ['local', 'claude'])
    expect(chosen.sessions?.limits).toEqual({ maxPermissionMode: 'auto', apps: { allowed: ['claude', 'local'] } })
    expect(allowedOutsideApps(chosen)).toEqual(['claude', 'local'])
  })

  test('All apps removes the key, and the objects it leaves empty', () => {
    const only: PolicyDocument = { schemaVersion: 1, organization: { name: 'Acme' }, sessions: { limits: { apps: { allowed: ['claude'] } } } }
    expect(withAllowedOutsideApps(only, null)).toEqual({ schemaVersion: 1, organization: { name: 'Acme' } })
    expect(withAllowedOutsideApps(withAllowedOutsideApps(base, ['claude']), null)).toEqual(base)
  })

  test('the last app stays on: a policy cannot allow no app', () => {
    expect(toggledOutsideApp(['claude'], 'claude', false)).toEqual(['claude'])
    expect(toggledOutsideApp(['claude', 'poke'], 'claude', false)).toEqual(['poke'])
    expect(toggledOutsideApp(['claude'], 'poke', true)).toEqual(['claude', 'poke'])
  })
})
