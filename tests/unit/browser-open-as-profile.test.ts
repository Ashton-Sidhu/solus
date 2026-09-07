import { describe, expect, test } from 'bun:test'
import type { BrowserTarget } from '@solus/contracts/browser-types'
import { openRequestFor } from '@solus/workspace-ui/components/browser/lib/profiles'

/**
 * Choosing an identity before a page exists.
 *
 * The picker's profile chip is the pane's project's set. The dev servers it
 * lists come from the whole host, so the address chosen next may belong to
 * another project — whose set does not contain the chosen id, and whose host
 * would refuse it (`profileForOpen`). The rule below is what keeps a choice
 * from becoming that refusal.
 */

const PROJECT = '/repo/app'

function target(projectRoot?: string): BrowserTarget {
  const t: BrowserTarget = { kind: 'url', url: 'http://localhost:3000' }
  if (projectRoot) t.projectRoot = projectRoot
  return t
}

describe('the profile the next page opens as', () => {
  test('rides along for a target in the project it was chosen for', () => {
    expect(openRequestFor(target(PROJECT), PROJECT, 'admin')).toEqual({
      target: target(PROJECT),
      profileId: 'admin',
    })
  })

  test('is dropped for a target in another project', () => {
    // WHY: an id is minted per project. Sending it to a project that has no
    // such profile is an error the user did nothing to earn; that project's
    // default is what the page's own chip then states.
    expect(openRequestFor(target('/repo/other'), PROJECT, 'admin')).toEqual({
      target: target('/repo/other'),
    })
    expect(openRequestFor(target(), PROJECT, 'admin')).toEqual({ target: target() })
  })

  test('is absent when none was chosen, so the host applies the project default', () => {
    // WHY: the default is the host's to decide (ADR 0023). Naming it from the
    // client would pin a page to whatever the client last saw.
    expect(openRequestFor(target(PROJECT), PROJECT, null)).toEqual({ target: target(PROJECT) })
  })

  test('a device target shares the hostless jar and takes no project choice', () => {
    const device: BrowserTarget = { kind: 'device', platform: 'ios', deviceId: 'sim-1' }
    expect(openRequestFor(device, PROJECT, 'admin')).toEqual({ target: device })
  })
})
