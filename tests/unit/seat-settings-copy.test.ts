import { describe, expect, test } from 'bun:test'
import { organizationConnectionsUrl } from '../../packages/workspace-ui/src/contexts/connections/host-routes'
import { seatSectionCopy } from '../../packages/workspace-ui/src/components/seats/lib/seat-copy'
import { parsePageRouteFragment } from '../../apps/client/src/lib/page-routes'

// docs/plans/cloud-service-model.md: a person connects their Claude and Codex logins
// once, in Solus cloud; every runner of the organization uses them for that person's turns.

describe('the seats section on a cloud row', () => {
  test('names the logins in Solus cloud and says what runners do with them', () => {
    const cloud = seatSectionCopy(true)
    expect(cloud.label).toBe('Your logins in Solus cloud')
    expect(cloud.description).toMatch(/runners use/i)
    expect(seatSectionCopy(false)).toEqual({ label: 'Your seats' })
  })
})

describe('the connections page link a runner shows a member', () => {
  test('lands on the page shell route the client parses', () => {
    // WHY: the link is built in the workspace UI, the route is read by the client
    // bundle on the account origin; the two must agree or the button opens nothing.
    const url = organizationConnectionsUrl('https://app.solus.sh/', 'org 1')
    expect(url).toBe('https://app.solus.sh/app/#/w/org%201/connections')
    expect(parsePageRouteFragment(new URL(url).hash)).toEqual({ organizationId: 'org 1', page: 'connections' })
  })
})
