import { describe, expect, test } from 'bun:test'
import { hostRowLabel } from '../../packages/workspace-ui/src/contexts/connections/host-label'
import { normalizeHostCapabilities } from '../../packages/client-core/src/host-capabilities'

describe('host row label', () => {
  test('the host\'s own name replaces a label this client only derived', () => {
    // WHY: a saved entry is named once, at pairing, from the address dialed or
    // from the label the host enrolled with — and neither the account directory
    // nor `/health` over a tunnel ever corrects it. A Mac whose `ComputerName`
    // is "Ashton's Mac mini" was showing the `hostname()` a much older build
    // enrolled. The capability record is the reading that follows a rename.
    const saved = { label: 'Ashtons-Mac-mini.local' }
    expect(hostRowLabel(saved, 'Ashton’s Mac mini')).toBe('Ashton’s Mac mini')
  })

  test('a name the user typed outranks the host\'s own', () => {
    // WHY: "Server name" in Add server is the user's wording for this machine.
    // Renaming the machine in system settings must not overwrite it.
    const saved = { label: 'Studio Mac', hasUserLabel: true }
    expect(hostRowLabel(saved, 'Ashton’s Mac mini')).toBe('Studio Mac')
  })

  test('a host too old to advertise a name leaves the saved label standing', () => {
    // WHY: `name` is absent on an older host, and absent must read as "no better
    // answer" — never as a blank row.
    expect(hostRowLabel({ label: 'Ashtons-Mac-mini.local' }, undefined)).toBe('Ashtons-Mac-mini.local')
    expect(hostRowLabel({ label: 'Ashtons-Mac-mini.local' }, '')).toBe('Ashtons-Mac-mini.local')
  })

  test('the capability decoder carries the name across the connection', () => {
    // WHY: the rule above is unreachable if the client drops the field while
    // normalizing an advertisement from the host.
    expect(normalizeHostCapabilities({ name: 'Ashton’s Mac mini' }).name).toBe('Ashton’s Mac mini')
    // A reshaped value degrades alone rather than blanking the whole record.
    expect(normalizeHostCapabilities({ name: 42, attachUpload: true }).attachUpload).toBe(true)
  })
})
