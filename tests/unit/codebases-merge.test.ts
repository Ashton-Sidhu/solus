import { describe, expect, test } from 'bun:test'
import type { Codebase } from '@solus/contracts/codebases'
import { mergeCodebases } from '@solus/client-core/codebases'

// docs/plans/codebases.md decision 6: each host keeps the full record. A
// client reads the copies of each connected host and sends the newest copy to
// each host that has an older one, so a change on one host reaches the others
// with no account service.

const copy = (id: string, updatedAt: number, overrides: Partial<Codebase> = {}): Codebase => ({
  id, name: id, roots: [], updatedAt, deletedAt: null, ...overrides,
})
const hosts = (entries: [string, Codebase[]][]) => new Map(entries)

describe('mergeCodebases', () => {
  test('the newest copy of each codebase is the current one', () => {
    const { codebases } = mergeCodebases(hosts([
      ['laptop', [copy('shop', 2_000, { name: 'shop, renamed' }), copy('tools', 1_000)]],
      ['server', [copy('shop', 1_000), copy('tools', 3_000, { name: 'tools, renamed' })]],
    ]))

    expect(codebases).toEqual([
      copy('shop', 2_000, { name: 'shop, renamed' }),
      copy('tools', 3_000, { name: 'tools, renamed' }),
    ])
  })

  test('a host is sent each copy it does not have and each copy it has an older one of', () => {
    const shop = copy('shop', 2_000)
    const tools = copy('tools', 3_000)
    const { stale } = mergeCodebases(hosts([
      ['laptop', [shop]],
      ['server', [copy('shop', 1_000), tools]],
      ['new-host', []],
    ]))

    expect(stale.get('laptop')).toEqual([tools])
    expect(stale.get('server')).toEqual([shop])
    expect(stale.get('new-host')).toEqual([shop, tools])
  })

  test('hosts that agree are sent nothing', () => {
    // WHY: a send makes each host broadcast a change. A merge that always sends would never go quiet.
    const { stale } = mergeCodebases(hosts([
      ['laptop', [copy('shop', 2_000)]],
      ['server', [copy('shop', 2_000)]],
    ]))
    expect(stale.size).toBe(0)
  })

  test('a tombstone wins over an older live copy, and the host with the live copy is sent the tombstone', () => {
    const tombstone = copy('shop', 5_000, { deletedAt: 5_000 })
    const { codebases, stale } = mergeCodebases(hosts([
      ['laptop', [tombstone]],
      ['server', [copy('shop', 1_000)]],
    ]))

    expect(codebases).toEqual([tombstone])
    expect(stale.get('server')).toEqual([tombstone])
    expect(stale.has('laptop')).toBe(false)
  })

  test('a live copy that is newer than a tombstone wins, so the codebase is back on each host', () => {
    const live = copy('shop', 6_000)
    const { codebases, stale } = mergeCodebases(hosts([
      ['laptop', [copy('shop', 5_000, { deletedAt: 5_000 })]],
      ['server', [live]],
    ]))

    expect(codebases).toEqual([live])
    expect(stale.get('laptop')).toEqual([live])
  })

  test('no hosts and no copies give nothing', () => {
    expect(mergeCodebases(new Map())).toEqual({ codebases: [], stale: new Map() })
  })
})
