import { expect, test } from 'bun:test'
import { isReachFailing, reachedMachineDetail, reachedMachines } from '@solus/client-core/reached-machines'

// WHY: docs/plans/host-reach.md §5. A host page lists each machine it reaches once,
// by the way the host dials it first (a pairing before an introduction), and a
// pairing that no longer works says so before an agent tries it.

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const listing = (id: string) => ({ id, installationId: id, label: id.toUpperCase(), routes: [], lastConnected: 0 })
const introduced = (id: string) => ({ installationId: id, label: id.toUpperCase(), url: `http://${id}:7777`, identityKey: `key-${id}`, introducedAt: 1 })

test('a machine reached both ways shows once, as paired, and the list is by name', () => {
  const machines = reachedMachines(
    { hosts: [{ listing: listing('nas'), pairedAt: 1, health: { lastReachedAt: NOW, lastError: null, expiresAt: NOW + 30 * DAY } }], forgotten: [] },
    { hosts: [introduced('nas'), introduced('box')], refused: [] },
    NOW,
  )
  expect(machines.map(({ installationId, way }) => [installationId, way])).toEqual([['box', 'introduced'], ['nas', 'paired']])
  expect(machines.map(reachedMachineDetail)).toEqual(['Introduced', 'Paired · Working'])
})

test('a pairing that failed or ended is failing; an introduction never is', () => {
  const [failing] = reachedMachines({ hosts: [{ listing: listing('nas'), pairedAt: 1, health: { lastReachedAt: 1, lastError: 'It refused the credential.', expiresAt: NOW + 30 * DAY } }], forgotten: [] }, null, NOW)
  const [ended] = reachedMachines({ hosts: [{ listing: listing('nas'), pairedAt: 1, health: { lastReachedAt: 1, lastError: null, expiresAt: null } }], forgotten: [] }, null, NOW)
  const [box] = reachedMachines(null, { hosts: [introduced('box')], refused: [] }, NOW)
  expect([failing!, ended!, box!].map(isReachFailing)).toEqual([true, true, false])
})
